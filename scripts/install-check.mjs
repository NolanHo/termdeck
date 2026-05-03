import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function check() {
    const pkg = require.resolve('node-pty/package.json');
    const root = pkg.slice(0, -'package.json'.length);
    const native = [
        join(root, 'build/Release/pty.node'),
        join(root, 'build/Debug/pty.node'),
        join(root, 'prebuilds'),
    ];
    if (!native.some(existsSync)) {
        throw new Error('node-pty native binding is missing. pnpm users must approve node-pty build scripts or install a package with prebuilt bindings.');
    }
}
try {
    check();
}
catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
//# sourceMappingURL=install-check.js.map