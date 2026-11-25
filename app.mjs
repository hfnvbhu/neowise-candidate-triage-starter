import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify as mockClassify } from "./mock-ai.mjs";
import { parseTriageInput, triage } from "./triage.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

// 64 КБ — около 32 тысяч символов русского текста; для одной заявки с запасом.
export const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/**
 * Тело запроса строкой или null, если оно больше MAX_BODY_BYTES.
 * Превышение дочитывается, но не хранится: память не растёт, а клиент получает ответ.
 */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

function logServerError(error) {
  console.error("[triage] server_error:", error);
}

/** HTTP-сервер без запуска. Модель и лог ошибок можно подменить в тестах. */
export function createApp({ classify = mockClassify, logError = logServerError } = {}) {
  async function handleTriage(request, response) {
    const body = await readBody(request);
    if (body === null) return json(response, 413, { status: "too_large" });
    const text = parseTriageInput(body);
    if (text === null) return json(response, 400, { status: "invalid_input" });
    return json(response, 200, await triage(text, classify));
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch (error) {
      logError(error);
      json(response, 500, { status: "server_error" });
    }
  });
}
