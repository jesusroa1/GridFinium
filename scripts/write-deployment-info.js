const fs = require("fs");
const path = require("path");

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

(function main() {
  var projectRoot = path.join(__dirname, "..");
  var distDir = path.join(projectRoot, "dist");
  ensureDirectory(distDir);

  var outputPath = path.join(distDir, "deployment.json");
  var payload = {
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
  });

  console.log("Wrote deployment metadata to", outputPath);
})();
