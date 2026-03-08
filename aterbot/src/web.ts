import HTTP from 'node:http';
import { getBotLogs, getBotStatus, sendChat } from './bot.ts';

const envPort = Number(process.env.PORT);
const PORT = Number.isInteger(envPort) && envPort > 0 ? envPort : process.PORT || 5500;

const JSON_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Content-Type": "application/json"
} as const;

const HTML_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Content-Type": "text/html; charset=utf-8"
} as const;

const renderPage = (): string => `<!doctype html>
<html lang="de">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>AterBot Chat</title>
	<style>
		:root {
			--bg: #0b1220;
			--panel: #121b2c;
			--line: #263246;
			--text: #e5e7eb;
			--muted: #9ca3af;
			--ok: #22c55e;
			--warn: #eab308;
			--bad: #f87171;
			--btn: #2563eb;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			font-family: "Segoe UI", Tahoma, sans-serif;
			background: radial-gradient(900px 500px at 18% -10%, #1e293b 0%, var(--bg) 70%);
			color: var(--text);
			padding: 14px;
		}
		.wrap {
			max-width: 980px;
			margin: 0 auto;
			display: grid;
			gap: 12px;
		}
		.panel {
			background: linear-gradient(180deg, rgba(18,27,44,0.95), rgba(12,18,31,0.95));
			border: 1px solid var(--line);
			border-radius: 12px;
			padding: 12px;
		}
		h1 {
			margin: 0;
			font-size: 1.1rem;
		}
		.status {
			margin-top: 8px;
			background: #0f1726;
			border: 1px solid var(--line);
			border-radius: 10px;
			padding: 10px;
			white-space: pre-wrap;
			font-size: 0.92rem;
		}
		.row {
			display: flex;
			gap: 8px;
			align-items: center;
			margin-top: 10px;
			flex-wrap: wrap;
		}
		input[type="text"] {
			flex: 1;
			min-width: 240px;
			padding: 10px 12px;
			background: #0b1220;
			border: 1px solid var(--line);
			border-radius: 8px;
			color: var(--text);
		}
		button {
			padding: 10px 14px;
			border: 1px solid transparent;
			border-radius: 8px;
			background: var(--btn);
			color: #fff;
			font-size: 0.93rem;
			cursor: pointer;
		}
		button:hover { filter: brightness(1.07); }
		.result {
			margin-top: 8px;
			font-size: 0.9rem;
			min-height: 1.2em;
			color: var(--warn);
		}
		.logs {
			background: #050a14;
			border: 1px solid var(--line);
			border-radius: 10px;
			padding: 10px;
			min-height: 220px;
			max-height: 420px;
			overflow: auto;
			font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
			font-size: 0.83rem;
			line-height: 1.4;
		}
		.muted { color: var(--muted); }
		.ok { color: var(--ok); }
		.warn { color: var(--warn); }
		.bad { color: var(--bad); }
	</style>
</head>
<body>
	<div class="wrap">
		<div class="panel">
			<h1>AterBot Chat + Live Debug</h1>
			<div id="status" class="status">Lade Status...</div>
			<div class="row">
				<input id="chatInput" type="text" placeholder="Nachricht eingeben, z.B. hallo" />
				<button id="sendBtn">Senden</button>
			</div>
			<div class="result" id="result"></div>
		</div>
		<div class="panel">
			<h1>Logs</h1>
			<div id="logs" class="logs"></div>
		</div>
	</div>

	<script>
		const statusEl = document.getElementById("status");
		const logsEl = document.getElementById("logs");
		const resultEl = document.getElementById("result");
		const inputEl = document.getElementById("chatInput");
		const sendBtn = document.getElementById("sendBtn");
		let logCursor = 0;

		const setResult = (text, ok) => {
			resultEl.textContent = text;
			resultEl.className = "result " + (ok ? "ok" : "warn");
		};

		const fmtPos = (pos) => pos
			? \`\${pos.x.toFixed(3)} / \${pos.y.toFixed(3)} / \${pos.z.toFixed(3)}\`
			: "-";

		const formatStatus = (s) => [
			\`Connected:            \${s.connected}\`,
			\`Spawned:              \${s.spawned}\`,
			\`Name:                 \${s.username}\`,
			\`EntityId:             \${s.entityId ?? "-"}\`,
			\`Confirmed Position:   \${fmtPos(s.confirmedPosition)}\`,
			\`Predicted Position:   \${fmtPos(s.predictedPosition)}\`,
			\`Yaw / Pitch:          \${s.yaw.toFixed(2)} / \${s.pitch.toFixed(2)}\`,
			\`Last Action:          \${s.lastAction ?? "-"}\`,
			\`Last Error:           \${s.lastError ?? "-"}\`,
			\`Packets OUT / IN:     \${s.packetCountOut} / \${s.packetCountIn}\`,
			\`Last Packet:          \${s.lastPacketAt ?? "-"}\`
		].join("\\n");

		const refreshStatus = async () => {
			try {
				const res = await fetch("/api/status");
				const data = await res.json();
				statusEl.textContent = formatStatus(data);
			} catch (_err) {
				statusEl.textContent = "Status konnte nicht geladen werden.";
			}
		};

		const appendLogs = (entries) => {
			if (!entries.length) return;
			const stick = logsEl.scrollTop + logsEl.clientHeight >= logsEl.scrollHeight - 12;
			for (const entry of entries) {
				const line = document.createElement("div");
				const cls = entry.level === "error" ? "bad" : entry.level === "debug" ? "muted" : "ok";
				const details = entry.details ? " " + JSON.stringify(entry.details) : "";
				line.className = cls;
				line.textContent = \`[\${entry.id}] \${entry.time} [\${entry.level}] \${entry.event}: \${entry.message}\${details}\`;
				logsEl.appendChild(line);
			}
			while (logsEl.childElementCount > 600) logsEl.removeChild(logsEl.firstChild);
			if (stick) logsEl.scrollTop = logsEl.scrollHeight;
		};

		const refreshLogs = async () => {
			try {
				const res = await fetch(\`/api/logs?since=\${logCursor}\`);
				const data = await res.json();
				logCursor = data.nextId || logCursor;
				appendLogs(data.logs || []);
			} catch (_err) {
				// ignore
			}
		};

		const sendChat = async () => {
			const message = inputEl.value.trim();
			if (!message) {
				setResult("Nachricht ist leer.", false);
				return;
			}
			try {
				const res = await fetch("/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ message })
				});
				const data = await res.json();
				setResult(data.message, Boolean(data.ok));
				if (data.ok) inputEl.value = "";
				await refreshStatus();
				await refreshLogs();
			} catch (_err) {
				setResult("Senden fehlgeschlagen.", false);
			}
		};

		sendBtn.addEventListener("click", sendChat);
		inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") sendChat();
		});

		refreshStatus();
		refreshLogs();
		setInterval(refreshStatus, 1000);
		setInterval(refreshLogs, 1000);
	</script>
</body>
</html>`;

const readJsonBody = async (request: HTTP.IncomingMessage): Promise<Record<string, unknown> | null> => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
};

const server = HTTP.createServer(async (request, response) => {
	const method = request.method ?? "GET";
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

	if (method === "OPTIONS") {
		response.writeHead(204, JSON_HEADERS);
		response.end();
		return;
	}

	if (url.pathname === "/api/status") {
		response.writeHead(200, JSON_HEADERS);
		response.end(JSON.stringify(getBotStatus()));
		return;
	}

	if (url.pathname === "/api/logs") {
		const since = Number(url.searchParams.get("since") ?? "0");
		const result = getBotLogs(Number.isFinite(since) ? since : 0);
		response.writeHead(200, JSON_HEADERS);
		response.end(JSON.stringify(result));
		return;
	}

	if (url.pathname === "/api/chat") {
		let message = "";
		if (method === "POST") {
			const body = await readJsonBody(request);
			const candidate = body?.message;
			message = typeof candidate === "string" ? candidate.trim() : "";
		}
		if (!message) {
			message = url.searchParams.get("message")?.trim() ?? "";
		}

		const result = sendChat(message);
		response.writeHead(result.ok ? 200 : 400, JSON_HEADERS);
		response.end(JSON.stringify({
			...result,
			status: getBotStatus()
		}));
		return;
	}

	response.writeHead(200, HTML_HEADERS);
	response.end(renderPage());
});

export default (): void => {
	server.listen(PORT, () => console.log("Server for UptimeRobot is ready!"));
};
