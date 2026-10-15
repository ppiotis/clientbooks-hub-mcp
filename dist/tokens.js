import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { decrypt, encrypt } from "./crypto.js";
export class TokenStore {
    file;
    key;
    constructor(file, key) {
        this.file = file;
        this.key = key;
    }
    requireKey() {
        if (!this.key)
            throw new Error("Set XERO_AGG_TOKEN_KEY (16+ chars, e.g. `openssl rand -base64 32`) so Xero tokens can be encrypted at rest.");
        return this.key;
    }
    async load() {
        let raw;
        try {
            raw = await readFile(this.file, "utf8");
        }
        catch (e) {
            if (e.code === "ENOENT")
                return { version: 1, connections: [] };
            throw e;
        }
        const data = JSON.parse(decrypt(raw, this.requireKey()));
        if (data.version !== 1 || !Array.isArray(data.connections))
            throw new Error("Unrecognised token file");
        return data;
    }
    async save(data) {
        const blob = encrypt(JSON.stringify(data), this.requireKey());
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, blob, { mode: 0o600 });
        await rename(tmp, this.file);
        await chmod(this.file, 0o600);
    }
}
