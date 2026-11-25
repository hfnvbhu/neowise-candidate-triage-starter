// Запуск: node --test   (или npm test). Нужен Node.js 20+, зависимостей нет.
import http from "node:http";
import { once } from "node:events";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BODY_BYTES, createApp } from "../app.mjs";
import { MODEL_TIMEOUT_MS } from "../triage.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
// Имитатор на [timeout] ждёт 1200 мс. Ответ быстрее этого порога доказывает, что сервер не ждёт модель дольше лимита.
const FAST_ENOUGH_MS = 1000;

// Без лимита сломанный тест висел бы вечно вместо того, чтобы упасть.
const TEST_OPTIONS = { timeout: 5000 };

// Сервер теста, прерванного по лимиту, остаётся открытым и не даёт node --test завершиться.
const openServers = new Set();
after(() => {
  for (const server of openServers) {
    server.closeAllConnections();
    server.close();
  }
});

async function withServer(options, run) {
  const server = createApp(options);
  openServers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/triage`;
  try {
    await run(url);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    openServers.delete(server);
  }
}

async function post(url, body) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json(), ms: performance.now() - started };
}

const ask = (text) => JSON.stringify({ text });

// --- Сбои модели: менеджер получает manual_review, а не мусор или ошибку 500 ---

const FAILURE_MARKERS = ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"];

for (const marker of FAILURE_MARKERS) {
  test(`сбой ${marker}: 200 и manual_review без темы и черновика`, TEST_OPTIONS, async () => {
    await withServer({}, async (url) => {
      const reply = await post(url, ask(`Когда будет доставка заказа? ${marker}`));
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, MANUAL_REVIEW);
      assert.ok(reply.ms < FAST_ENOUGH_MS, `ответ занял ${Math.round(reply.ms)} мс`);
    });
  });
}

test("модель, которая зависла и игнорирует отмену, всё равно отсекается по таймауту", TEST_OPTIONS, async () => {
  let receivedSignal;
  const hangingModel = (_text, { signal }) => {
    receivedSignal = signal;
    return new Promise(() => {});
  };
  await withServer({ classify: hangingModel }, async (url) => {
    const reply = await post(url, ask("Сколько стоит доставка?"));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, MANUAL_REVIEW);
    assert.ok(reply.ms >= MODEL_TIMEOUT_MS - 5, `ответ пришёл раньше лимита: ${Math.round(reply.ms)} мс`);
    assert.ok(reply.ms < FAST_ENOUGH_MS, `ответ занял ${Math.round(reply.ms)} мс`);
    assert.equal(receivedSignal.aborted, true, "модели должен прийти сигнал отмены");
  });
});

const BAD_MODEL_OUTPUTS = [
  // Не строка: JSON.parse превратил бы массив в строку '{"topic":…}' и принял бы такой ответ.
  ["массив с JSON-строкой", async () => [JSON.stringify({ topic: "delivery", draft: "Ответ" })]],
  // JSON null: без проверки на объект разбор ответа упал бы, и сервер ответил бы 500.
  ["JSON null", async () => "null"],
  // Черновик непустой, но менеджер увидел бы на экране пустое место.
  ["черновик из невидимых символов", async () => JSON.stringify({ topic: "other", draft: "\u200b\u2060 \u00ad" })],
  ["черновик из управляющих символов", async () => JSON.stringify({ topic: "other", draft: "\u0000\u0007" })],
];

for (const [name, model] of BAD_MODEL_OUTPUTS) {
  test(`неподходящий ответ модели (${name}) уходит в manual_review`, TEST_OPTIONS, async () => {
    await withServer({ classify: model }, async (url) => {
      const reply = await post(url, ask("Где мой заказ?"));
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, MANUAL_REVIEW);
    });
  });
}

// --- Некорректный ввод: 400 и модель не вызывается ---

const INVALID_BODIES = [
  ["пустой text", ask("")],
  ["text из одних пробелов", ask("  \n\t ")],
  ["text из невидимых символов", ask("\u200b\u200d\u2060\u00ad")],
  ["text из управляющих символов", ask("\u0000\u0007")],
  ["нет поля text", JSON.stringify({ message: "Доставка" })],
  ["text — число", JSON.stringify({ text: 42 })],
  ["text — null", JSON.stringify({ text: null })],
  ["массив вместо объекта", JSON.stringify([{ text: "Доставка" }])],
  ["null вместо объекта", "null"],
  ["строка вместо объекта", JSON.stringify("Доставка")],
  ["битый JSON", '{"text": "Доставка"'],
  ["пустое тело", ""],
];

for (const [name, body] of INVALID_BODIES) {
  test(`некорректный ввод (${name}): 400 invalid_input`, TEST_OPTIONS, async () => {
    let calls = 0;
    const model = async () => {
      calls += 1;
      return JSON.stringify({ topic: "other", draft: "Ответ" });
    };
    await withServer({ classify: model }, async (url) => {
      const reply = await post(url, body);
      assert.equal(reply.status, 400);
      assert.deepEqual(reply.body, { status: "invalid_input" });
      assert.equal(calls, 0, "модель не должна вызываться на некорректном вводе");
    });
  });
}

test("слишком большое тело: 413 too_large, модель не вызывается", TEST_OPTIONS, async () => {
  let calls = 0;
  const model = async () => {
    calls += 1;
    return JSON.stringify({ topic: "delivery", draft: "Ответ" });
  };
  await withServer({ classify: model }, async (url) => {
    const text = "доставка ".repeat(Math.ceil(MAX_BODY_BYTES / 8));
    const reply = await post(url, ask(text));
    assert.equal(reply.status, 413);
    assert.deepEqual(reply.body, { status: "too_large" });
    assert.equal(calls, 0);
  });
});

test("клиент оборвал запрос: ошибка пишется в лог, сервер продолжает работать", TEST_OPTIONS, async () => {
  let resolveLogged;
  const logged = new Promise((resolve) => {
    resolveLogged = resolve;
  });
  await withServer({ logError: (error) => resolveLogged(error) }, async (url) => {
    const request = http.request(url, { method: "POST", headers: { "Content-Length": "1000" } });
    request.on("error", () => {});
    request.write('{"text":"Доставка');
    await new Promise((resolve) => setTimeout(resolve, 50));
    request.destroy();

    const error = await logged;
    assert.equal(error.code, "ECONNRESET");

    const reply = await post(url, ask("Когда будет доставка?"));
    assert.equal(reply.status, 200);
    assert.equal(reply.body.status, "ready");
  });
});

// --- Успешный разбор ---

const READY_CASES = [
  ["Когда будет доставка?", "delivery"],
  ["Какая цена у тарифа?", "pricing"],
  ["Хочу оставить отзыв", "other"],
];

for (const [text, topic] of READY_CASES) {
  test(`корректный ответ модели: 200 ready с темой ${topic}`, TEST_OPTIONS, async () => {
    await withServer({}, async (url) => {
      const reply = await post(url, ask(text));
      assert.equal(reply.status, 200);
      assert.deepEqual(Object.keys(reply.body), ["status", "topic", "draft"]);
      assert.equal(reply.body.status, "ready");
      assert.equal(reply.body.topic, topic);
      assert.ok(reply.body.draft.trim().length > 0);
    });
  });
}

test("лишние поля из ответа модели не попадают в API", TEST_OPTIONS, async () => {
  const model = async () => JSON.stringify({ topic: "other", draft: "  Ответ  ", internal: "секрет" });
  await withServer({ classify: model }, async (url) => {
    const reply = await post(url, ask("Вопрос"));
    assert.deepEqual(reply.body, { status: "ready", topic: "other", draft: "Ответ" });
  });
});
