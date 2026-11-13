"""Build the extension distribution using an explicit source-file allowlist."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "manifest.json").read_text())["version"]
output = root / "dist" / f"magnific_history2json_v{version}.zip"
output.parent.mkdir(exist_ok=True)
files = ["manifest.json", "background.js", "parser.js", "report.js", "feed.js", "offscreen.html", "offscreen.js", "zip.js", "options.html", "options.js", "start.html", "README.md", "docs/VALIDATION.md"]
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, name)
    guide = root / "docs" / "magnific_history2json_guide_ru.pdf"
    if guide.exists():
        archive.write(guide, "docs/magnific_history2json_guide_ru.pdf")
    for icon in sorted((root / "icons").glob("*.png")):
        archive.write(icon, icon.relative_to(root))
print(output)
