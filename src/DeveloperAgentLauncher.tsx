export default function DeveloperAgentLauncher() {
  return (
    <button
      className="developer-fab"
      aria-label="開発"
      onClick={() => window.dispatchEvent(new CustomEvent('devdeck:open-developer'))}
    >
      ⌘
    </button>
  );
}
