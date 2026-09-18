import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import {
  assertCronHistory,
  seedCronHistory,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-cron-history.mjs";
import { migrateLegacyCronRunLogsToTaskRuns } from "../../src/infra/state-migrations.cron-run-logs.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/e2e/lib/upgrade-survivor/legacy-operator-cron-history.mjs");
const diagnostics = path.resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");

function prepare(version = "2026.9.4") {
  const root = tempDirs.make("survivor-cron-history-");
  const stateDir = path.join(root, "state");
  const artifacts = path.join(root, "artifacts");
  const observations = path.join(artifacts, "observation");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "package");
  mkdirSync(path.join(stateDir, "state"), { recursive: true });
  mkdirSync(observations, { recursive: true });
  const schema = version === "2026.9.4" ? 17 : 16;
  for (const [directory, packageVersion, stateSchema] of [
    [baseline, version, schema],
    [candidate, "2026.9.4", 17],
  ] as const) {
    mkdirSync(path.join(directory, "dist"), { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: packageVersion,
        type: "module",
        openclaw: { schemaVersions: { state: stateSchema } },
      }),
    );
    writeFileSync(
      path.join(directory, "dist/build-info.json"),
      JSON.stringify({ fixture: directory }),
    );
  }
  const databasePath = path.join(stateDir, "state/openclaw.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${schema}`);
  db.close();
  writeFileSync(
    path.join(artifacts, "legacy-operator-baseline.json"),
    JSON.stringify({
      jobs: [{ id: "retained-main" }, { id: "retained-ops" }],
    }),
  );
  const tarball = path.join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  seedCronHistory(stateDir, artifacts, baseline, tarball);
  const entry = path.join(candidate, "openclaw.mjs");
  // This process qualifies the observer, not an installed Doctor. The real
  // published updater cell must exercise Doctor's admission and full ordering.
  writeFileSync(
    entry,
    `
    import { DatabaseSync } from 'node:sqlite';
    import { migrateLegacyCronRunLogsToTaskRuns } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/state-migrations.cron-run-logs.ts")).href)};
    if (process.env.FIXTURE_IMPORT === '1') {
      const db = new DatabaseSync(${JSON.stringify(databasePath)});
      db.exec('BEGIN IMMEDIATE');
      migrateLegacyCronRunLogsToTaskRuns(db);
      db.exec('PRAGMA user_version = 17; COMMIT');
      db.close();
    }
  `,
  );
  const invoke = (importHistory: boolean) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--import",
        diagnostics,
        "--import",
        helper,
        entry,
        "doctor",
        "--fix",
        "--non-interactive",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: observations,
          OPENCLAW_UPGRADE_SURVIVOR_CRON_HISTORY_FIXTURE: path.join(
            artifacts,
            "legacy-operator-cron-history.json",
          ),
          FIXTURE_IMPORT: importHistory ? "1" : "0",
        },
      },
    );
  return { artifacts, observations, databasePath, invoke };
}

it.each(["2026.9.3", "2026.9.4"])(
  "distinguishes %s Doctor import from current-schema import",
  (version) => {
    const fixture = prepare(version);
    const result = fixture.invoke(true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    assertCronHistory(fixture.artifacts, fixture.observations);
    const evidence = JSON.parse(
      readFileSync(path.join(fixture.artifacts, "legacy-operator-cron-history-proof.json"), "utf8"),
    );
    expect(evidence.currentSchemaAtDoctorEntry).toBe(version === "2026.9.4");
    expect(evidence.doctor.before.legacyRows).toHaveLength(2);
    expect(evidence.doctor.after.tasks).toHaveLength(2);
    if (version === "2026.9.3") {
      writeFileSync(
        path.join(fixture.artifacts, "summary.json"),
        JSON.stringify({
          status: "passed",
          baseline: { spec: `openclaw@${version}`, version },
          candidate: { kind: "tarball", version: "2026.9.4" },
          scenario: "legacy-operator-state",
          installedVersion: "2026.9.4",
          candidateInstallMode: "updater",
          updateRestartMode: "manual",
          updateOutcome: "success",
          phases: [],
        }),
      );
      const published = path.join(fixture.artifacts, "published");
      publishDiagnostics(fixture.artifacts, published, (text: string) => text, "passed");
      const summary = JSON.parse(readFileSync(path.join(published, "summary.json"), "utf8"));
      expect(JSON.parse(summary.logs["legacy-operator-cron-history-proof.json"])).toEqual(evidence);
    }
  },
);

it("rejects a successful Doctor exit which leaves retained history for startup", () => {
  const fixture = prepare();
  const result = fixture.invoke(false);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(() => assertCronHistory(fixture.artifacts, fixture.observations)).toThrow(
    "table was not retired",
  );
});

it("rejects parent-side import even when canonical task rows and Doctor exit are correct", () => {
  const fixture = prepare();
  const db = new DatabaseSync(fixture.databasePath);
  migrateLegacyCronRunLogsToTaskRuns(db);
  db.close();
  const result = fixture.invoke(false);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(() => assertCronHistory(fixture.artifacts, fixture.observations)).toThrow(
    "never received the unchanged retained cron history",
  );
});
