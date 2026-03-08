import * as Bedrock from 'bedrock-protocol';
import CONFIG from "../config.json" with { type: 'json' };

type BedrockClient = ReturnType<typeof Bedrock.createClient>;
type RaknetBackend = 'jsp-raknet' | 'raknet-native' | 'raknet-node';
type BotAction = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'turn_left' | 'turn_right' | 'stop';
type Vec3 = { x: number; y: number; z: number };
type InputFlags = Record<string, boolean>;

export type BotStatus = {
	connected: boolean;
	spawned: boolean;
	username: string;
	entityId: number | null;
	confirmedPosition: Vec3 | null;
	predictedPosition: Vec3 | null;
	yaw: number;
	pitch: number;
	lastAction: string | null;
	lastError: string | null;
	packetCountOut: number;
	packetCountIn: number;
	lastPacketAt: string | null;
};

export type BotLogEntry = {
	id: number;
	time: string;
	level: "debug" | "info" | "error";
	event: string;
	message: string;
	details?: Record<string, unknown>;
};

const MAX_LOGS = 300;
const INPUT_INTERVAL_MS = 50;
const DEFAULT_ACTION_MS = 400;
const MOVE_SPEED_PER_TICK = 0.13;
const JUMP_SPEED_PER_TICK = 0.08;
const TURN_STEP = 22.5;

let bot: BedrockClient | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let actionTimer: NodeJS.Timeout | null = null;

let spawned = false;
let entityId: number | null = null;
let confirmedPosition: Vec3 | null = null;
let predictedPosition: Vec3 | null = null;
let yaw = 0;
let pitch = 0;
let tick = 0n;

let lastAction: string | null = null;
let lastError: string | null = null;
let packetCountOut = 0;
let packetCountIn = 0;
let lastPacketAt: string | null = null;

let logSeq = 0;
const logBuffer: BotLogEntry[] = [];

const safeJson = (value: unknown): string => JSON.stringify(
	value,
	(_key, item) => typeof item === "bigint" ? item.toString() : item
);

const pushLog = (
	level: "debug" | "info" | "error",
	event: string,
	message: string,
	details?: Record<string, unknown>
): void => {
	const entry: BotLogEntry = {
		id: ++logSeq,
		time: new Date().toISOString(),
		level,
		event,
		message,
		details
	};

	logBuffer.push(entry);
	if (logBuffer.length > MAX_LOGS) logBuffer.shift();

	const rendered = details ? `${message} ${safeJson(details)}` : message;
	if (level === "error") {
		console.error(rendered);
		return;
	}
	console.log(rendered);
};

const parsePort = (): number => {
	const port = Number(CONFIG.client.port);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 19132;
};

const parseConnectTimeout = (): number => {
	const timeout = Number(CONFIG.client.connectTimeout);
	return Number.isInteger(timeout) && timeout > 0 ? timeout : 9000;
};

const parseRetryDelay = (): number => {
	const delay = Number(CONFIG.action.retryDelay);
	return Number.isInteger(delay) && delay > 0 ? delay : 15000;
};

const parseRaknetBackend = (): RaknetBackend => {
	const backend = CONFIG.client.raknetBackend;
	return backend === 'jsp-raknet' || backend === 'raknet-native' || backend === 'raknet-node'
		? backend
		: 'raknet-native';
};

const parseVec3 = (value: unknown): Vec3 | null => {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const x = Number(candidate.x);
	const y = Number(candidate.y);
	const z = Number(candidate.z);
	return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
};

const parseRotation = (value: unknown): { pitch: number; yaw: number } | null => {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const x = Number(candidate.x);
	// bedrock start_game rotation uses { x: pitch, z: yaw }
	const z = Number(candidate.z);
	if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
	return { pitch: x, yaw: z };
};

const normalizeYaw = (degrees: number): number => {
	let normalized = degrees % 360;
	if (normalized <= -180) normalized += 360;
	if (normalized > 180) normalized -= 360;
	return normalized;
};

const stopActionLoop = (): void => {
	if (!actionTimer) return;
	clearInterval(actionTimer);
	actionTimer = null;
};

const resetRuntimeState = (): void => {
	stopActionLoop();
	spawned = false;
	entityId = null;
	confirmedPosition = null;
	predictedPosition = null;
	yaw = 0;
	pitch = 0;
	tick = 0n;
	packetCountOut = 0;
	packetCountIn = 0;
	lastPacketAt = null;
};

const closeClient = (client: BedrockClient): void => {
	client.removeAllListeners();
	client.close();
};

const ensureActionReady = (): { ok: boolean; message: string } => {
	if (!bot) return { ok: false, message: "Bot is not connected." };
	if (!spawned || entityId === null) return { ok: false, message: "Bot is not spawned yet." };
	if (!predictedPosition && !confirmedPosition) return { ok: false, message: "Position is not available yet." };
	return { ok: true, message: "ok" };
};

const ensureChatReady = (): { ok: boolean; message: string } => {
	if (!bot) return { ok: false, message: "Bot is not connected." };
	if (!spawned || entityId === null) return { ok: false, message: "Bot is not spawned yet." };
	return { ok: true, message: "ok" };
};

const sendInputStep = (forwardAxis: number, strafeAxis: number, jump: boolean): { ok: boolean; message: string } => {
	const state = ensureActionReady();
	if (!state.ok) return state;
	if (!bot || entityId === null) return { ok: false, message: "Bot is not connected." };

	const current = predictedPosition ?? confirmedPosition;
	if (!current) return { ok: false, message: "Position is not available yet." };

	const yawRad = (yaw * Math.PI) / 180;
	const pitchRad = (pitch * Math.PI) / 180;

	const forwardVec = { x: -Math.sin(yawRad), z: Math.cos(yawRad) };
	const rightVec = { x: Math.cos(yawRad), z: Math.sin(yawRad) };

	const dx = (forwardVec.x * forwardAxis + rightVec.x * strafeAxis) * MOVE_SPEED_PER_TICK;
	const dz = (forwardVec.z * forwardAxis + rightVec.z * strafeAxis) * MOVE_SPEED_PER_TICK;
	const dy = jump ? JUMP_SPEED_PER_TICK : 0;

	const nextPosition: Vec3 = {
		x: current.x + dx,
		y: current.y + dy,
		z: current.z + dz
	};

	const inputData: InputFlags = {};
	if (forwardAxis > 0) inputData.up = true;
	if (forwardAxis < 0) inputData.down = true;
	if (strafeAxis > 0) inputData.right = true;
	if (strafeAxis < 0) inputData.left = true;
	if (forwardAxis !== 0 || strafeAxis !== 0) {
		inputData.sprinting = true;
		inputData.sprint_down = true;
	}
	if (jump) {
		inputData.jumping = true;
		inputData.jump_down = true;
		inputData.start_jumping = true;
		inputData.jump_pressed_raw = true;
		inputData.jump_current_raw = true;
	}

	tick += 1n;
	bot.queue('player_auth_input', {
		pitch,
		yaw,
		position: current,
		move_vector: { x: strafeAxis, y: forwardAxis },
		head_yaw: yaw,
		input_data: inputData,
		input_mode: 'mouse',
		play_mode: 'normal',
		interaction_model: 'crosshair',
		interact_rotation: { x: pitch, y: yaw },
		tick,
		delta: { x: dx, y: dy, z: dz },
		analogue_move_vector: { x: strafeAxis, y: forwardAxis },
		camera_orientation: {
			x: -Math.sin(yawRad) * Math.cos(pitchRad),
			y: -Math.sin(pitchRad),
			z: Math.cos(yawRad) * Math.cos(pitchRad)
		},
		raw_move_vector: { x: strafeAxis, y: forwardAxis }
	});

	// Fallback for servers that still accept classic move packets.
	bot.queue('move_player', {
		runtime_id: entityId,
		position: nextPosition,
		pitch,
		yaw,
		head_yaw: yaw,
		mode: 'normal',
		on_ground: true,
		ridden_runtime_id: 0,
		tick
	});

	predictedPosition = nextPosition;
	packetCountOut += 2;
	lastPacketAt = new Date().toISOString();
	pushLog("debug", "out_input", "Sent movement input tick.", {
		tick: tick.toString(),
		forwardAxis,
		strafeAxis,
		jump,
		predictedPosition: nextPosition
	});
	return { ok: true, message: "Action sent." };
};

const runActionLoop = (forwardAxis: number, strafeAxis: number, jump: boolean, durationMs: number): { ok: boolean; message: string } => {
	const state = ensureActionReady();
	if (!state.ok) return state;

	stopActionLoop();

	const steps = Math.max(1, Math.min(40, Math.ceil(durationMs / INPUT_INTERVAL_MS)));
	let sent = 0;

	const doStep = (): void => {
		sent += 1;
		sendInputStep(forwardAxis, strafeAxis, jump);
		if (sent >= steps) stopActionLoop();
	};

	doStep();
	actionTimer = setInterval(doStep, INPUT_INTERVAL_MS);
	pushLog("info", "action_loop", `Started action loop (${steps} ticks).`, {
		forwardAxis,
		strafeAxis,
		jump
	});
	return { ok: true, message: `Action queued (${steps} ticks).` };
};

export const performAction = (action: string, durationMs = DEFAULT_ACTION_MS): { ok: boolean; message: string } => {
	const normalized = action.trim().toLowerCase() as BotAction;
	lastAction = normalized;

	switch (normalized) {
		case 'forward':
			return runActionLoop(1, 0, false, durationMs);
		case 'back':
			return runActionLoop(-1, 0, false, durationMs);
		case 'left':
			return runActionLoop(0, -1, false, durationMs);
		case 'right':
			return runActionLoop(0, 1, false, durationMs);
		case 'jump':
			return runActionLoop(0, 0, true, Math.min(250, durationMs));
		case 'turn_left':
			yaw = normalizeYaw(yaw - TURN_STEP);
			return runActionLoop(0, 0, false, 60);
		case 'turn_right':
			yaw = normalizeYaw(yaw + TURN_STEP);
			return runActionLoop(0, 0, false, 60);
		case 'stop':
			stopActionLoop();
			pushLog("info", "action_stop", "Stopped action loop.");
			return { ok: true, message: "Stopped." };
		default:
			return { ok: false, message: `Unknown action: ${action}` };
	}
};

export const sendChat = (input: string): { ok: boolean; message: string } => {
	const state = ensureChatReady();
	if (!state.ok) return state;
	if (!bot) return { ok: false, message: "Bot is not connected." };

	const message = input.trim();
	if (!message) return { ok: false, message: "Message is empty." };

	bot.queue('text', {
		needs_translation: false,
		category: 'message_only',
		type: 'chat',
		source_name: CONFIG.client.username,
		message,
		xuid: '',
		platform_chat_id: '',
		has_filtered_message: false
	});

	packetCountOut += 1;
	lastPacketAt = new Date().toISOString();
	pushLog("info", "out_chat", "Sent chat message.", { message });
	return { ok: true, message: "Chat message sent." };
};

export const getBotStatus = (): BotStatus => ({
	connected: bot !== null,
	spawned,
	username: CONFIG.client.username,
	entityId,
	confirmedPosition,
	predictedPosition,
	yaw,
	pitch,
	lastAction,
	lastError,
	packetCountOut,
	packetCountIn,
	lastPacketAt
});

export const getBotLogs = (since = 0): { nextId: number; logs: BotLogEntry[] } => ({
	nextId: logSeq,
	logs: logBuffer.filter(entry => entry.id > since)
});

const scheduleReconnect = (client: BedrockClient, reason: string): void => {
	if (bot !== client || reconnectTimer) return;

	lastError = reason;
	pushLog("error", "reconnect", reason);
	console.log(`Trying to reconnect in ${parseRetryDelay() / 1000} seconds...\n`);

	bot = null;
	resetRuntimeState();
	closeClient(client);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		createBot();
	}, parseRetryDelay());
};

const createBot = (): void => {
	const client = Bedrock.createClient({
		host: CONFIG.client.host,
		port: parsePort(),
		username: CONFIG.client.username,
		offline: CONFIG.client.offline !== false,
		connectTimeout: parseConnectTimeout(),
		skipPing: true,
		raknetBackend: parseRaknetBackend()
	} as const);
	bot = client;
	lastError = null;
	pushLog("info", "connect", "Creating Bedrock client.", {
		host: CONFIG.client.host,
		port: parsePort(),
		offline: CONFIG.client.offline !== false,
		raknetBackend: parseRaknetBackend()
	});

	client.once('join', () => {
		pushLog("info", "join", `AFKBot joined as ${CONFIG.client.username}.`);
	});
	client.once('spawn', () => {
		spawned = true;
		entityId = Number(client.entityId);
		pushLog("info", "spawn", "AFKBot spawned successfully.", { entityId });
	});
	client.on('start_game', packet => {
		const startPosition = parseVec3((packet as Record<string, unknown>).player_position);
		if (startPosition) {
			confirmedPosition = startPosition;
			predictedPosition = startPosition;
		}

		const startRotation = parseRotation((packet as Record<string, unknown>).rotation);
		if (startRotation) {
			pitch = startRotation.pitch;
			yaw = normalizeYaw(startRotation.yaw);
		}

		const runtimeEntity = Number((packet as Record<string, unknown>).runtime_entity_id);
		if (Number.isFinite(runtimeEntity)) entityId = runtimeEntity;

		pushLog("info", "start_game", "Received start_game packet.", {
			entityId,
			confirmedPosition,
			yaw,
			pitch
		});
	});
	client.on('move_player', packet => {
		if (entityId === null) return;
		const runtimeId = Number((packet as Record<string, unknown>).runtime_id);
		if (!Number.isFinite(runtimeId) || runtimeId !== entityId) return;

		const nextPosition = parseVec3((packet as Record<string, unknown>).position);
		if (nextPosition) {
			confirmedPosition = nextPosition;
			predictedPosition = nextPosition;
		}

		const nextYaw = Number((packet as Record<string, unknown>).yaw);
		const nextPitch = Number((packet as Record<string, unknown>).pitch);
		if (Number.isFinite(nextYaw)) yaw = normalizeYaw(nextYaw);
		if (Number.isFinite(nextPitch)) pitch = nextPitch;

		packetCountIn += 1;
		lastPacketAt = new Date().toISOString();
		pushLog("debug", "in_move_player", "Received self move_player packet.", {
			confirmedPosition,
			yaw,
			pitch
		});
	});
	client.on('correct_player_move_prediction', packet => {
		const nextPosition = parseVec3((packet as Record<string, unknown>).position);
		if (nextPosition) {
			confirmedPosition = nextPosition;
			predictedPosition = nextPosition;
		}
		packetCountIn += 1;
		lastPacketAt = new Date().toISOString();
		pushLog("debug", "in_correction", "Received correction packet.", {
			confirmedPosition
		});
	});
	client.on('error', error => {
		lastError = String(error);
		pushLog("error", "error", `AFKBot error: ${String(error)}`);
		scheduleReconnect(client, "Connection error, reconnecting...");
	});
	client.on('kick', packet => {
		const message = typeof packet?.message === "string" ? packet.message.trim() : "";
		const reason = message.length > 0
			? message
			: packet?.reason || safeJson(packet);
		lastError = reason;
		scheduleReconnect(client, `AFKBot was kicked: ${reason}`);
	});
	client.on('close', () => {
		scheduleReconnect(client, "Connection closed, reconnecting...");
	});
};

export default (): void => {
	createBot();
};
