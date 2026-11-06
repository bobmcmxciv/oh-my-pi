// Integration test — real OS processes are required (ts-no-test-timers
// exception): the subject under test is live process state, so fake timers
// cannot stand in, and each await below blocks on a real event (the child's
// reported pid, the parent's exit) rather than a guessed duration.
import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import { Process } from "@oh-my-pi/pi-natives";
import { pinProcess, terminateProcessTree } from "../src/ptree";

const isRunning = (proc: Process | undefined): boolean => {
	try {
		return proc?.status() === "running";
	} catch {
		return false;
	}
};

// These run inside spawned child processes; their timers hold the fake
// children alive (or exit the parent on cue), they are not test-side waits.
const PARENT_SPAWNS_THEN_EXITS = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
console.log("CHILD_PID=" + child.pid);
child.unref();
// Let the CHILD_PID line flush to the pipe before the wrapper exits.
setTimeout(() => process.exit(0), 200);
`;

const PARENT_SPAWNS_THEN_HOLDS = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
console.log("CHILD_PID=" + child.pid);
setInterval(() => {}, 1000);
`;

interface SpawnedParent {
	pid: number;
	childPid: number;
	exited: Promise<unknown>;
}

/** Spawn a parent script and resolve once it reports its child's pid. */
async function spawnParent(script: string): Promise<SpawnedParent> {
	const parent = nodeSpawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	const exited = once(parent, "exit");
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	let buffer = "";
	parent.stdout.on("data", chunk => {
		buffer += chunk.toString();
		const match = /CHILD_PID=(\d+)/.exec(buffer);
		if (match) resolve(Number(match[1]));
	});
	void exited.then(() => reject(new Error("parent exited before reporting its child pid")));
	const childPid = await promise;
	return { pid: parent.pid!, childPid, exited };
}

/** Force-kill whatever leaked so a failing assertion never orphans test processes. */
function cleanup(...pids: Array<number | undefined>): void {
	for (const pid of pids) {
		if (pid === undefined) continue;
		try {
			Process.fromPid(pid)?.killTree(9);
		} catch {}
	}
}

describe("terminateProcessTree", () => {
	it("kills a live root together with its child", async () => {
		const { pid, childPid } = await spawnParent(PARENT_SPAWNS_THEN_HOLDS);
		const root = pinProcess(pid);
		expect(root).toBeDefined();
		const child = pinProcess(childPid);
		expect(isRunning(child)).toBe(true);
		try {
			await terminateProcessTree(root!);
			expect(isRunning(root)).toBe(false);
			expect(isRunning(child)).toBe(false);
		} finally {
			cleanup(pid, childPid);
		}
	}, 15_000);

	// The reported proc://kill shape: the supervising wrapper has already exited
	// when the kill lands. Unix reparents orphans to init, where no parent-pid
	// walk can find them — outside this helper's reach. Windows keeps the stale
	// parent pid recorded, so a pinned root handle must still sweep the orphan.
	it.skipIf(process.platform !== "win32")(
		"sweeps a grandchild orphaned under a dead root",
		async () => {
			const parent = await spawnParent(PARENT_SPAWNS_THEN_EXITS);
			const root = pinProcess(parent.pid); // pinned while the parent is still alive
			expect(root).toBeDefined();
			await parent.exited; // the wrapper is gone before the kill lands
			expect(isRunning(root)).toBe(false);
			const orphan = pinProcess(parent.childPid);
			expect(isRunning(orphan)).toBe(true);
			try {
				// A bare terminate() returns true here without ever signalling the
				// orphan — the regression this guards.
				await terminateProcessTree(root!);
				expect(isRunning(orphan)).toBe(false);
			} finally {
				cleanup(parent.childPid);
			}
		},
		15_000,
	);

	it("returns false without invoking raw taskkill when the target pid cannot be pinned", async () => {
		if (process.platform !== "win32") return;
		// An unopenable PID has no verified kernel identity; Windows must fail
		// closed instead of shelling out to taskkill on a numeric PID.
		expect(await terminateProcessTree(999_999_999)).toBe(false);
	});
});
