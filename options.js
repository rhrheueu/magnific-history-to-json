const EXPORT_MODE_WITH_IMAGES = "with_images";
const EXPORT_MODE_TEXT_ONLY = "text_only";

const statusEl = document.getElementById("status");
const modeInputs = Array.from(document.querySelectorAll('input[name="exportMode"]'));

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b91c1c" : "#0f766e";
}

function applySelection(mode) {
  const selected = mode === EXPORT_MODE_TEXT_ONLY ? EXPORT_MODE_TEXT_ONLY : EXPORT_MODE_WITH_IMAGES;
  for (const input of modeInputs) {
    input.checked = input.value === selected;
  }
}

function getSelectedMode() {
  const selected = modeInputs.find((input) => input.checked);
  return selected?.value === EXPORT_MODE_TEXT_ONLY ? EXPORT_MODE_TEXT_ONLY : EXPORT_MODE_WITH_IMAGES;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function loadMode() {
  try {
    const response = await sendMessage({ type: "MAGNIFIC_GET_EXPORT_MODE" });
    if (!response?.ok) throw new Error(response?.error || "Failed to load export mode.");
    applySelection(response.exportMode);
    setStatus("");
  } catch (error) {
    applySelection(EXPORT_MODE_WITH_IMAGES);
    setStatus(error.message || "Не удалось загрузить настройку.", true);
  }
}

async function saveMode() {
  const exportMode = getSelectedMode();
  try {
    const response = await sendMessage({
      type: "MAGNIFIC_SET_EXPORT_MODE",
      exportMode
    });
    if (!response?.ok) throw new Error(response?.error || "Failed to save export mode.");
    const text =
      response.exportMode === EXPORT_MODE_TEXT_ONLY
        ? "Сохранено: режим «Только текст»."
        : "Сохранено: режим «С картинками».";
    setStatus(text);
  } catch (error) {
    setStatus(error.message || "Не удалось сохранить настройку.", true);
  }
}

for (const input of modeInputs) {
  input.addEventListener("change", () => {
    void saveMode();
  });
}

void loadMode();
