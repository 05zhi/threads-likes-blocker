"""Package the committed extension with matching panel and background builds."""
from io import BytesIO
from pathlib import Path
import hashlib
import json
import re
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
prefix = "threads-likes-blocker/"
data = subprocess.check_output(
    ["git", "archive", "--format=zip", f"--prefix={prefix}", "HEAD"], cwd=root
)
with zipfile.ZipFile(BytesIO(data)) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    files = [name for name in names if not name.endswith("/")]
    for name in files:
        relative = name.removeprefix(prefix)
        assert not relative.startswith(("work/", "evidence/", ".git/", "node_modules/"))
        assert relative != "VERIFICATION.md"
        assert ".." not in Path(relative).parts
    manifest = json.loads(archive.read(prefix + "extension/manifest.json"))
    version = manifest["version"]
    assert re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version)
    for filename, constant in [("content.js", "EXTENSION_VERSION"), ("background.js", "BUILD_VERSION")]:
        source = archive.read(prefix + "extension/" + filename).decode("utf-8")
        match = re.search(rf'const {constant}\s*=\s*[\'"]([0-9.]+)[\'"]', source)
        assert match and match[1] == version, f"Mixed build in {filename}"
    for size, name in manifest["icons"].items():
        assert archive.read(prefix + "extension/" + name).startswith(b"\x89PNG\r\n\x1a\n")
destination = root.parent / f"threads-likes-blocker-v{version}.zip"
destination.write_bytes(data)
print(json.dumps({"path": str(destination), "version": version, "files": len(files),
                  "sha256": hashlib.sha256(data).hexdigest()}))
