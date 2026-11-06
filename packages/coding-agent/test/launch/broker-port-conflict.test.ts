// Integration test — real sockets and a real broker (ts-no-test-timers
// exception): the regression is readiness credited to a foreign listener, so
// the test binds real TCP ports and awaits real broker RPC results; fake
// timers cannot stand in for kernel port ownership.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
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

/** Occupy a port with a foreign listener; resolves with the bound port. */
function occupyPort(): Promise<{ server: net.Server; port: number }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ server: net.Server; port: number }>();
	const server = net.createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
	});
	return promise;
}

function spec(overrides: Partial<DaemonSpec>): DaemonSpec {
	return {
		name: "svc",
		application: process.execPath,
		args: ["-e", "setInterval(() => {}, 1000)"],
		env: {},
		cwd: process.cwd(),
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
		...overrides,
	};
}

describe("daemon broker ready.port", () => {
	it("fails a service whose ready.port is already occupied, leaving the foreign listener alone", async () => {
		using tempDir = TempDir.createSync("@omp-launch-port-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const previousTitle = process.title;
		const { server: foreign, port } = await occupyPort();
		const client: DaemonBrokerClient = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 3_000,
		});
		const previous = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
			name => [name, process.env[name]] as const,
		);
		process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		process.env[DAEMON_IDLE_GRACE_ENV] = "3000";
		const broker = startDaemonBrokerFromEnvironment();
		for (const [name, value] of previous) restoreEnv(name, value);
		try {
			const started = await client.request({
				op: "start",
				spec: spec({
					name: "conflict",
					args: ["-e", `require("net").createServer().listen(${port}, "127.0.0.1")`],
					ready: { port, timeoutMs: 5_000 },
				}),
			});
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unreachable");
			// The launch must fail before spawn — never "ready" off the foreign listener.
			expect(started.daemon.state).toBe("failed");
			expect(started.daemon.exitReason).toContain("already in use");
			expect(started.daemon.pid).toBeUndefined();
			// The foreign listener was not killed and still accepts connections.
			const probe = await new Promise<boolean>(resolve => {
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
			});
			expect(probe).toBe(true);
		} finally {
			client.close();
			foreign.close();
			await broker;
			process.title = previousTitle;
		}
	}, 30_000);

	it("marks ready on a free port it binds itself, and requires log+port together", async () => {
		using tempDir = TempDir.createSync("@omp-launch-ready-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const previousTitle = process.title;
		const port = await freePort();
		const client: DaemonBrokerClient = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 3_000,
		});
		const previous = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
			name => [name, process.env[name]] as const,
		);
		process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		process.env[DAEMON_IDLE_GRACE_ENV] = "3000";
		const broker = startDaemonBrokerFromEnvironment();
		for (const [name, value] of previous) restoreEnv(name, value);
		try {
			// Positive control: the child binds its own port and reports ready.
			const bound = await client.request({
				op: "start",
				spec: spec({
					name: "binder",
					args: ["-e", `require("net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000)`],
					ready: { port, timeoutMs: 10_000 },
				}),
			});
			expect(bound.op).toBe("start");
			if (bound.op !== "start") throw new Error("unreachable");
			expect(bound.daemon.state).toBe("ready");
			expect(bound.daemon.readyAt).toBeDefined();

			// log+port: the log pattern matches immediately but the port never
			// binds, so the service must stay "starting" and time out — one
			// satisfied condition must never report ready alone.
			const partial = await client.request({
				op: "start",
				spec: spec({
					name: "partial",
					args: ["-e", 'console.log("READY_NOW"); setInterval(() => {}, 1000)'],
					ready: { log: "READY_NOW", port: await freePort(), timeoutMs: 1_000 },
				}),
			});
			expect(partial.op).toBe("start");
			if (partial.op !== "start") throw new Error("unreachable");
			expect(partial.daemon.state).toBe("starting");
			expect(partial.readyTimedOut).toBe(true);
		} finally {
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 30_000);
});
