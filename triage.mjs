// Логика разбора заявки отдельно от HTTP (он в app.mjs): проверка ввода,
// вызов модели с ограничением по времени и проверка ответа модели.

const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;

const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });

// Видимый символ: не пробел, не невидимый (zero-width space, word joiner, мягкий перенос и т. п.)
// и не управляющий (NUL, BEL и т. п.). trim() убирает только пробелы, поэтому строка из одних
// невидимых или управляющих символов прошла бы проверку.
const VISIBLE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]/u;

/** true, если в строке есть хотя бы один видимый символ. */
function hasVisibleText(value) {
  return typeof value === "string" && VISIBLE.test(value);
}

/** Текст заявки из сырого тела запроса или null, если ввод некорректен. */
export function parseTriageInput(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const text = body?.text;
  if (!hasVisibleText(text)) return null;
  return text.trim();
}

/**
 * Единственное место, где проверяется ответ модели.
 * Возвращает ответ API со статусом ready или null, если ответ нельзя показывать менеджеру.
 */
function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const topic = data?.topic;
  const draft = data?.draft;
  if (!TOPICS.has(topic)) return null;
  if (!hasVisibleText(draft)) return null;
  return { status: "ready", topic, draft: draft.trim() };
}

/**
 * Ждёт модель не дольше MODEL_TIMEOUT_MS. Отмена через signal — вежливая просьба,
 * а Promise.race гарантирует срок, даже если модель signal игнорирует.
 */
async function callModel(classify, text) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Model did not answer within ${MODEL_TIMEOUT_MS} ms`);
      reject(error);
      controller.abort(error);
    }, MODEL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Возвращает тело ответа API: ready с темой и черновиком или manual_review. */
export async function triage(text, classify) {
  let raw;
  try {
    raw = await callModel(classify, text);
  } catch {
    return MANUAL_REVIEW;
  }
  return parseModelOutput(raw) ?? MANUAL_REVIEW;
}
