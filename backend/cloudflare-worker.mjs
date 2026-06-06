const CLOUD_CAPACITY = 18;
const CLOUD_TTL_MS = 18000;
const MESSAGE_MAX_LENGTH = 96;
const MAX_QUEUE_SIZE = 80;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

export class SkyRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, 204);
    }

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId") || "";

    await this.cleanup();

    if (request.method === "GET" && url.pathname.endsWith("/state")) {
      return jsonResponse(await this.snapshot(clientId));
    }

    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      return this.submit(request);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  async readState() {
    return {
      active: (await this.state.storage.get("active")) || [],
      queue: (await this.state.storage.get("queue")) || [],
    };
  }

  async writeState(nextState) {
    await this.state.storage.put("active", nextState.active);
    await this.state.storage.put("queue", nextState.queue);
  }

  async cleanup() {
    const now = Date.now();
    const current = await this.readState();
    const active = current.active.filter((message) => message.expiresAt > now);
    const queue = [...current.queue];

    while (active.length < CLOUD_CAPACITY && queue.length > 0) {
      active.push(startMessage(queue.shift(), now));
    }

    await this.writeState({ active, queue });
  }

  async submit(request) {
    const body = await request.json().catch(() => ({}));
    const text = sanitizeText(body.text);
    const clientId = sanitizeClientId(body.clientId);

    if (!text) {
      return jsonResponse({ error: "Empty message" }, 400);
    }

    const now = Date.now();
    const current = await this.readState();
    const active = current.active.filter((message) => message.expiresAt > now);
    const queue = [...current.queue];
    const message = {
      id: crypto.randomUUID(),
      text,
      clientId,
      createdAt: now,
    };
    let status = "active";

    if (active.length < CLOUD_CAPACITY) {
      active.push(startMessage(message, now));
    } else {
      if (queue.length >= MAX_QUEUE_SIZE) {
        return jsonResponse({ error: "Queue is full" }, 429);
      }

      queue.push(message);
      status = "queued";
    }

    await this.writeState({ active, queue });

    const snapshot = await this.snapshot(clientId, { active, queue });

    return jsonResponse({
      ...snapshot,
      acceptedId: message.id,
      status,
    });
  }

  async snapshot(clientId, providedState) {
    const current = providedState || (await this.readState());
    const ownQueueIndex = clientId
      ? current.queue.findIndex((message) => message.clientId === clientId)
      : -1;

    return {
      active: current.active,
      capacity: CLOUD_CAPACITY,
      queueSize: current.queue.length,
      ownQueuePosition: ownQueueIndex >= 0 ? ownQueueIndex + 1 : null,
      serverTime: Date.now(),
    };
  }
}

export default {
  fetch(request, env) {
    const id = env.SKY_ROOM.idFromName("global");
    return env.SKY_ROOM.get(id).fetch(request);
  },
};

function startMessage(message, now) {
  return {
    ...message,
    startedAt: now,
    expiresAt: now + CLOUD_TTL_MS,
  };
}

function sanitizeText(value) {
  return [...String(value || "")
    .trim()
    .replace(/\s+/g, " ")]
    .slice(0, MESSAGE_MAX_LENGTH)
    .join("");
}

function sanitizeClientId(value) {
  return String(value || "")
    .replace(/[^\w-]/g, "")
    .slice(0, 80);
}

function jsonResponse(data, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
}
