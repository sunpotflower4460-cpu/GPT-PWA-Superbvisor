export default function DeveloperAgentLauncher() {
  return (
    <button
      className="developer-fab"
      aria-label="GitHub Developer Agent"
      onClick={() => window.dispatchEvent(new CustomEvent('devdeck:open-developer'))}
    >
      ⌘
    </button>
  );
}
