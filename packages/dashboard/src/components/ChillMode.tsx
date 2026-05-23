import { useEffect, useRef } from "react";
import { useFleetStore } from "../stores/fleet";

export function ChillMode() {
  const { chillNotifications, dismissChillNotification, setMode, selectAgent, setActiveAgent } = useFleetStore();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const timers: number[] = [];
    for (const n of chillNotifications) {
      const age = Date.now() - n.ts;
      if (age < 5000) {
        timers.push(window.setTimeout(() => dismissChillNotification(n.id), 5000 - age));
      } else {
        dismissChillNotification(n.id);
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [chillNotifications]);

  useEffect(() => {
    if (!iframeRef.current?.contentWindow) return;
    const latest = chillNotifications[chillNotifications.length - 1];
    if (latest) {
      iframeRef.current.contentWindow.postMessage(
        { type: "thronglet_notification", agentName: latest.agentName, text: latest.text },
        "*"
      );
    }
  }, [chillNotifications]);

  const handleNotificationClick = (agentName: string) => {
    selectAgent(agentName);
    setActiveAgent(agentName);
    setMode("work");
  };

  return (
    <div className="chill-mode">
      <iframe
        ref={iframeRef}
        className="chill-iframe"
        src="/chill/index.html"
        title="Thronglets Habitat"
      />
      <div className="chill-toasts">
        {chillNotifications.slice(-3).map((n) => (
          <div
            key={n.id}
            className="chill-toast"
            onClick={() => handleNotificationClick(n.agentName)}
          >
            <span className="chill-toast-icon">💬</span>
            <span className="chill-toast-text">
              <strong>{n.agentName}</strong> sent a message
            </span>
            <button className="chill-toast-close" onClick={(e) => { e.stopPropagation(); dismissChillNotification(n.id); }}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
