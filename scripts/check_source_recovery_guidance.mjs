#!/usr/bin/env node

/**
 * Required-invariant check for the generic source-recovery guidance.
 * This is intentionally documentation/example-only: it must not import the
 * producer, protocol schema, persistence adapter, or a domain consumer.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recoveryPath = resolve(ROOT, "skills/chatgpt/SOURCE_RECOVERY.md");
const skillPath = resolve(ROOT, "skills/chatgpt/SKILL.md");
const scalingPath = resolve(ROOT, "docs/25_p0_large_run_scaling.md");
const examplePath = resolve(ROOT, "examples/rewards-optimizer/source-recovery.example.json");

const recovery = readFileSync(recoveryPath, "utf8");
const skill = readFileSync(skillPath, "utf8");
const scaling = readFileSync(scalingPath, "utf8");
const example = JSON.parse(readFileSync(examplePath, "utf8"));
const failures = [];

function requireText(text, marker, label) {
  if (!text.includes(marker)) failures.push(`${label}: missing ${marker}`);
}

for (const marker of [
  "registered locator",
  "normal browser headers",
  "bounded",
  "429",
  "5xx",
  "alternate candidates",
  "static, PDF, language, or CDN",
  "JavaScript-empty",
  "operator_capture_required",
  "publisher, domain, title, and role marker",
  "recovery_detail",
  "legacy null-detail hash fallback",
  "LR-D006",
]) requireText(recovery, marker, "SOURCE_RECOVERY.md");

for (const marker of [
  "http_failure",
  "js_empty",
  "marker_missing",
  "partial_role",
  "safety_rejected",
  "resolved",
  "never log in",
  "CAPTCHA",
  "WAF",
  "search snippet",
]) requireText(skill, marker, "SKILL.md");

requireText(scaling, "operator_capture_required", "docs/25_p0_large_run_scaling.md");
requireText(scaling, "does not decide", "docs/25_p0_large_run_scaling.md");

if (example.synthetic !== true) failures.push("example: synthetic must be true");
if (example.trust !== "untrusted") failures.push("example: trust must be untrusted");
if (!example.target || !Array.isArray(example.target.locators) || example.target.locators.length !== 2) {
  failures.push("example: exactly two locator inputs are required");
}
if (!Array.isArray(example.attempts) || example.attempts.length < 1) failures.push("example: attempts are required");
const outcomes = new Set(example.outcome_vocabulary);
for (const outcome of ["http_failure", "js_empty", "marker_missing", "partial_role", "safety_rejected", "resolved"]) {
  if (!outcomes.has(outcome)) failures.push(`example: missing outcome vocabulary ${outcome}`);
}
for (let index = 0; index < (example.attempts ?? []).length; index += 1) {
  const attempt = example.attempts[index];
  if (attempt?.attempt_number !== index + 1) failures.push(`example: attempt numbers must be contiguous at ${index + 1}`);
  if (!outcomes.has(attempt?.outcome)) failures.push(`example: unsupported attempt outcome at ${index + 1}`);
}
if (example.terminal?.outcome !== "operator_capture_required" || example.terminal?.resolved !== false) {
  failures.push("example: unresolved terminal must be operator_capture_required with resolved=false");
}
if (example.persistence?.agent_feed_wire_payload !== false) failures.push("example: must not be an Agent Feed wire payload");
if (example.persistence?.ledger_label_preservation !== "recovery_detail") failures.push("example: exact labels must be represented by recovery_detail");

const unsafe = /(?:https?:\/\/[^/\s]+@|[?#]|data:|(?:bearer|basic)[\s:=]+[A-Za-z0-9._~+/=-]{8,}|(?:api[_-]?key|access[_-]?key|password|secret|token|cookie)[\s:=/]+[^\s/]+)/iu;
const serialized = JSON.stringify(example);
if (unsafe.test(serialized)) failures.push("example: locator or value resembles credential-bearing material");

if (failures.length) {
  console.error(`Source-recovery guidance failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Source-recovery guidance checks passed (bounded ladder, safety boundary, outcomes, and synthetic unresolved trace).");
}
