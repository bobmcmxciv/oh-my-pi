// Integration test — real processes/ports and a real broker
// (ts-no-test-timers exception): the regression is a Windows proc://kill that
// signals only the wrapper and strands bun/node grandchildren holding a port.
// The test waits on real RPC results and real socket events, never timers.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { type DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function freePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>(resolve => server.close(() => resolve()));
	return port;
}

function connectable(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ host: "127.0.0.1", port });
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	socket.setTimeout(1_000, () => {
		socket.destroy();
		resolve(false);
	});
	return promise;
}

function spec(overrides: Partial<DaemonSpec>): DaemonSpec {
	return {
		name: "tree",
		application: process.execPath,
		args: [],
		env: {},
		cwd: process.cwd(),
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
		...overrides,
	};
}

/** Poll a condition until it holds or the deadline passes — awaits real state, not a fixed delay. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(25);
	}
}

async function withBroker<T>(run: (client: DaemonBrokerClient, projectDir: string) => Promise<T>): Promise<T> {
	using tempDir = TempDir.createSync("@omp-launch-tree-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const previousTitle = process.title;
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 3_000 });
	const previous = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "3000";
	const broker = startDaemonBrokerFromEnvironment();
	for (const [name, value] of previous) restoreEnv(name, value);
	try {
		return await run(client, projectDir);
	} finally {
		client.close();
		await broker;
		process.title = previousTitle;
	}
}

describe("daemon broker tree kill", () => {
	// A live supervised service that spawns a child and a detached grandchild:
	// stop must take down the whole tree and release the grandchild's port.
	it("stop kills parent, child, and detached grandchild and releases its port", async () => {
		const port = await freePort();
		await withBroker(async client => {
			const started = await client.request({
				op: "start",
				spec: spec({
					args: [
						"-e",
						`const { spawn } = require("node:child_process");
						 const child = spawn(process.execPath, ["-e", \`
						  const { spawn } = require("node:child_process");
						  const gc = spawn(process.execPath, ["-e",
						   "require('net').createServer().listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000)"
						  ], { stdio: "ignore", detached: true });
						  console.log("CHILD_PID=" + process.pid + " GC_PID=" + gc.pid);
						  gc.unref();
						  setInterval(() => {}, 1000);
						 \`], { stdio: ["ignore", "inherit", "inherit"] });
						 setInterval(() => {}, 1000);`,
					],
				}),
			});
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unreachable");
			expect(started.daemon.state).toBe("running");

			// Wait for the grandchild's listener to be connectable — its GC_PID
			// line arrived on the daemon log, so the spawn has completed.
			const gcLine = await client.request({
				op: "wait",
				name: "tree",
				for: "exit",
				pattern: "CHILD_PID=(\\d+) GC_PID=(\\d+)",
				timeoutMs: 10_000,
			});
			expect(gcLine.op).toBe("wait");
			if (gcLine.op !== "wait") throw new Error("unreachable");
			const match = /CHILD_PID=(\d+) GC_PID=(\d+)/.exec(gcLine.matched ?? "");
			const childPid = Number(match?.[1]);
			const gcPid = Number(match?.[2]);
			expect(childPid).toBeGreaterThan(0);
			expect(gcPid).toBeGreaterThan(0);
			expect(await eventually(() => connectable(port))).toBe(true);

			const stopped = await client.request({ op: "stop", name: "tree", timeoutMs: 5_000 });
			expect(stopped.op).toBe("stop");

			// The grandchild is gone and its port released — the old code
			// terminated only the wrapper and left bun/node survivors behind.
			expect(Process.fromPid(started.daemon.pid ?? 0)?.status() ?? "exited").not.toBe("running");
			expect(Process.fromPid(childPid)?.status() ?? "exited").not.toBe("running");
			expect(Process.fromPid(gcPid)?.status() ?? "exited").not.toBe("running");
			expect(await connectable(port)).toBe(false);
		});
	}, 30_000);
});
