/**
 * i18n 词条检查：三种语言 key/参数完整一致（§8.3 发布验收要求零缺失）。
 * 运行：npm run check:i18n
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LOCALES = ["zh-Hans", "zh-Hant", "en"];

function flatten(value, prefix = "", out = new Map()) {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object") flatten(item, path, out);
    else out.set(path, String(item));
  }
  return out;
}

function paramsOf(text) {
  return new Set([...text.matchAll(/\{(\w+)/g)].map((match) => match[1]));
}

const bundles = Object.fromEntries(
  LOCALES.map((locale) => [locale, flatten(JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")))]),
);

const reference = bundles["zh-Hans"];
assert(reference.size > 0, "简体词条不能为空");

for (const locale of LOCALES) {
  const bundle = bundles[locale];
  for (const key of reference.keys()) {
    assert(bundle.has(key), `${locale} 缺少词条：${key}`);
  }
  for (const key of bundle.keys()) {
    assert(reference.has(key), `${locale} 存在多余词条：${key}`);
  }
  for (const [key, text] of bundle) {
    assert(text.trim().length > 0, `${locale} 词条为空：${key}`);
    const expected = [...paramsOf(reference.get(key))].sort().join(",");
    const actual = [...paramsOf(text)].sort().join(",");
    assert.equal(actual, expected, `${locale} 词条参数不一致：${key}`);
  }
}

console.log(`i18n 词条一致：${LOCALES.join(" / ")}，共 ${reference.size} 个键，参数与复数结构核对通过。`);
