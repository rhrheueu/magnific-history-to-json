const statusEl = document.getElementById("status");
const diagnosticInput = document.getElementById("diagnostic-json");
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b91c1c" : "#0f766e";
}
function sendMessage(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(response);
  }));
}
function applyMode(mode) {
  diagnosticInput.checked = mode === "text_only";
  setStatus(diagnosticInput.checked
    ? "Диагностика включена на один запуск. Затем вернётся отчёт с картинками."
    : "Обычный режим: отчёт с картинками.");
}
async function loadMode() {
  try {
    const response = await sendMessage({ type: "MAGNIFIC_GET_EXPORT_MODE" });
    if (!response?.ok) throw new Error("Не удалось загрузить настройки.");
    applyMode(response.exportMode);
  } catch (error) { setStatus(error.message, true); }
}
diagnosticInput.addEventListener("change", async () => {
  try {
    const response = await sendMessage({ type: "MAGNIFIC_SET_EXPORT_MODE", exportMode: diagnosticInput.checked ? "text_only" : "with_images" });
    if (!response?.ok) throw new Error(response?.error || "Не удалось сохранить настройку.");
    applyMode(response.exportMode);
  } catch (error) { setStatus(error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.exportMode) applyMode(changes.exportMode.newValue);
});
void loadMode();
