/**
 * UI module.
 * Owns all DOM reads/writes so app logic doesn't touch raw elements directly.
 */

export function createUI({ onSubmitQuestion, onBeginDivination, onReset }) {
  const questionInput = document.getElementById("question-input");
  const askButton = document.getElementById("ask-button");
  const beginButton = document.getElementById("begin-button");
  const resetButton = document.getElementById("reset-button");
  const answerEl = document.getElementById("oracle-answer");

  askButton?.addEventListener("click", () => {
    onSubmitQuestion?.(questionInput?.value ?? "");
  });

  questionInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      onSubmitQuestion?.(questionInput.value);
    }
  });

  beginButton?.addEventListener("click", () => {
    onBeginDivination?.();
  });

  resetButton?.addEventListener("click", () => {
    onReset?.();
  });

  return {
    render(state) {
      const hasQuestion = Boolean(state.question);
      if (beginButton) {
        beginButton.disabled = !hasQuestion;
      }
      if (answerEl) {
        answerEl.textContent = state.answer || "No answer yet.";
      }
    },
    setQuestion(value) {
      if (questionInput) questionInput.value = value;
    },
  };
}
