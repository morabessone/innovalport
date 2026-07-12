import { useEffect, useRef, useState } from "react";

// Escáner de código de barras con la cámara. Usa la API nativa BarcodeDetector
// cuando está disponible (Chrome/Android); si no, ofrece ingreso manual.
export function Scanner({ onDetect, onClose }: { onDetect: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [soportado, setSoportado] = useState(true);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    const Detector = (window as unknown as { BarcodeDetector?: new (o: unknown) => { detect: (v: unknown) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!Detector) { setSoportado(false); return; }
    const detector = new Detector({ formats: ["ean_13", "ean_8", "code_128", "upc_a", "qr_code"] });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const tick = async () => {
          if (!videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length) { onDetect(codes[0].rawValue); return; }
          } catch (_e) { /* ignore frame errors */ }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (_e) {
        setError("No se pudo acceder a la cámara. Ingresá el código a mano.");
      }
    })();

    return () => { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onDetect]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="between" style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: "1.05rem" }}>Escanear código</h3>
          <button className="btn ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        {soportado && !error && (
          <div className="scan-frame"><video ref={videoRef} playsInline muted /><div className="scan-line" /></div>
        )}
        {(error || !soportado) && <p className="muted" style={{ marginBottom: 10 }}>{error ?? "Este navegador no soporta escaneo con cámara."}</p>}
        <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
          <label>O ingresá el código / SKU a mano</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input grow" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Código de barras o SKU" autoFocus={!soportado} />
            <button className="btn primary" disabled={!manual.trim()} onClick={() => onDetect(manual.trim())}>Usar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
