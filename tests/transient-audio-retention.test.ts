import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TransientAudioStore } from "../src/server/transient-audio";

test("private native audio is retained briefly and physically removed after TTL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-transient-audio-"));
  const store = new TransientAudioStore(directory, 25, 10_000);
  try {
    const asset = await store.save("audio-user", "native-session-001", `data:audio/mp4;base64,${Buffer.from("private audio bytes").toString("base64")}`);
    assert.match(asset.id, /^tmpaud_/);
    assert.equal(asset.mime, "audio/mp4");
    const userDirectory = path.join(directory, "audio-user");
    const names = await readdir(userDirectory);
    assert.equal(names.length, 1);
    const info = await stat(path.join(userDirectory, names[0]));
    assert.equal(info.mode & 0o077, 0, "transient audio must not be group/world readable");
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(await store.cleanup(), 1);
    await assert.rejects(readdir(userDirectory), /ENOENT/);
  } finally {
    store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
