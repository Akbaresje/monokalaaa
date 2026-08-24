import { useCallback, useRef, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { isSupabaseReady, supabase } from "../../lib/supabase";

/**
 * ImageUploader — komponen upload & edit foto menu.
 *
 * Fitur:
 *  - Pilih file dari perangkat (kamera / galeri di mobile)
 *  - Drag & drop di desktop
 *  - Modal crop dengan zoom, rotasi, rasio aspek
 *  - Auto-kompresi output (max width 1200px, JPEG 82%)
 *  - Upload otomatis ke Supabase Storage (bucket "menu-images")
 *    → kalau bucket / Supabase tidak ada, fallback simpan sebagai base64 data URL
 *
 * Cara pakai:
 *   <ImageUploader value={draft.image} onChange={(url) => set("image", url)} />
 *
 * Setup bucket (jalankan sekali di SQL Editor Supabase):
 *   insert into storage.buckets (id, name, public) values ('menu-images','menu-images',true);
 *   create policy "public read"  on storage.objects for select using (bucket_id='menu-images');
 *   create policy "public write" on storage.objects for insert with check (bucket_id='menu-images');
 *   create policy "public update" on storage.objects for update using (bucket_id='menu-images');
 */

type Props = {
  value?: string;
  onChange: (url: string) => void;
  /** Rasio crop w/h. Default 1 (square) — cocok untuk grid menu MONOKALA. */
  aspect?: number;
  /** Kualitas JPEG output 0..1. Default 0.82. */
  quality?: number;
  /** Lebar maksimum output (auto-scale). Default 1200. */
  maxWidth?: number;
  className?: string;
};

const BUCKET = "menu-images";

/* ── Utilities ─────────────────────────────────────────────────────── */

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result as string);
    reader.onerror = () => rej(new Error("read fail"));
    reader.readAsDataURL(file);
  });

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("load fail"));
    img.src = src;
  });

/** Ambil bagian yang di-crop → canvas → JPEG blob. */
async function getCroppedBlob(
  imageSrc: string,
  area: Area,
  rotation: number,
  maxWidth: number,
  quality: number,
): Promise<Blob> {
  const image = await loadImage(imageSrc);

  // Untuk rotasi 90/270, tukar sisi
  const rot = ((rotation % 360) + 360) % 360;
  const swapSides = rot === 90 || rot === 270;

  // Canvas antara: full ukuran gambar untuk rotasi
  const safeArea = Math.max(image.width, image.height) * 2;
  const stage = document.createElement("canvas");
  stage.width = safeArea;
  stage.height = safeArea;
  const sctx = stage.getContext("2d")!;
  sctx.translate(safeArea / 2, safeArea / 2);
  sctx.rotate((rot * Math.PI) / 180);
  sctx.translate(-image.width / 2, -image.height / 2);
  sctx.drawImage(image, 0, 0);

  // Ambil crop area dari canvas rotasi
  const data = sctx.getImageData(
    Math.round(safeArea / 2 - image.width / 2 + area.x),
    Math.round(safeArea / 2 - image.height / 2 + area.y),
    Math.round(area.width),
    Math.round(area.height),
  );

  // Canvas final + resize ke maxWidth
  const targetW = Math.min(swapSides ? area.height : area.width, maxWidth);
  const scale = targetW / area.width;
  const out = document.createElement("canvas");
  out.width = Math.round(area.width * scale);
  out.height = Math.round(area.height * scale);
  const octx = out.getContext("2d")!;

  // paste data ke ukuran asli dulu, lalu scale
  const tmp = document.createElement("canvas");
  tmp.width = Math.round(area.width);
  tmp.height = Math.round(area.height);
  tmp.getContext("2d")!.putImageData(data, 0, 0);
  octx.drawImage(tmp, 0, 0, out.width, out.height);

  return new Promise((resolve, reject) => {
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("blob fail"))),
      "image/jpeg",
      quality,
    );
  });
}

/** Upload ke Supabase Storage bila tersedia, else return base64. */
async function persist(blob: Blob): Promise<string> {
  if (isSupabaseReady() && supabase) {
    const ext = "jpg";
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { data, error } = await supabase.storage.from(BUCKET).upload(path, blob, {
      contentType: "image/jpeg",
      upsert: false,
    });
    if (!error && data) {
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
      return pub.publicUrl;
    }
    // Fallback: bucket belum dibuat / RLS block → simpan base64
    console.warn("[ImageUploader] upload gagal, fallback base64:", error?.message);
  }
  return await blobToDataUrl(blob);
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("blob read"));
    r.readAsDataURL(blob);
  });

/* ── Component ─────────────────────────────────────────────────────── */

export default function ImageUploader({
  value,
  onChange,
  aspect = 1,
  quality = 0.82,
  maxWidth = 1200,
  className = "",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [srcRaw, setSrcRaw] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [area, setArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  const openFile = () => inputRef.current?.click();

  const handleFile = async (f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return;
    // Batasi ukuran mentah agar tidak crash saat crop (10 MB)
    if (f.size > 10 * 1024 * 1024) {
      alert("Ukuran gambar terlalu besar (maks 10 MB). Kompres dulu.");
      return;
    }
    const url = await readAsDataUrl(f);
    setSrcRaw(url);
    setZoom(1);
    setRotation(0);
    setCrop({ x: 0, y: 0 });
    setArea(null);
  };

  const onCropComplete = useCallback((_c: Area, pixels: Area) => setArea(pixels), []);

  const applyCrop = async () => {
    if (!srcRaw || !area) return;
    setBusy(true);
    try {
      const blob = await getCroppedBlob(srcRaw, area, rotation, maxWidth, quality);
      const url = await persist(blob);
      onChange(url);
      setSrcRaw(null);
    } catch (e) {
      console.error(e);
      alert("Gagal memproses gambar. Coba file lain.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <span className="smallcaps text-[9px] text-muted">foto menu</span>

      {/* Preview / drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        className={`mt-2 overflow-hidden rounded-[10px] border transition-colors ${
          drag ? "border-forest bg-forest/5" : "border-sand bg-linen-2"
        }`}
      >
        {value ? (
          <div className="relative">
            <img src={value} alt="preview" className="h-44 w-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 flex justify-between gap-2 bg-gradient-to-t from-ink/70 to-transparent px-4 py-3">
              <button
                type="button"
                onClick={openFile}
                className="smallcaps rounded-full bg-linen/90 px-3 py-1.5 text-[9px] text-ink hover:bg-linen"
              >
                ganti
              </button>
              <button
                type="button"
                onClick={() => onChange("")}
                className="smallcaps rounded-full bg-[#8b3a3a]/85 px-3 py-1.5 text-[9px] text-linen hover:bg-[#8b3a3a]"
              >
                hapus
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={openFile}
            className="flex h-44 w-full flex-col items-center justify-center gap-2 text-center"
          >
            <svg viewBox="0 0 24 24" className="h-8 w-8 text-muted/60" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="9" cy="10" r="2" />
              <path d="m3 18 5-4 4 3 3-2 6 5" />
            </svg>
            <div className="text-[13px] font-medium text-ink">Unggah foto</div>
            <div className="text-[10.5px] font-light text-muted">
              Klik atau seret file ke sini · JPG/PNG · maks 10&nbsp;MB
            </div>
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {/* Crop modal */}
      {srcRaw && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/70 p-4">
          <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-[14px] bg-linen">
            <div className="flex items-center justify-between border-b border-sand px-5 py-3">
              <div>
                <div className="font-display text-[16px] text-ink">Sesuaikan Foto</div>
                <div className="smallcaps text-[9px] text-muted">
                  geser · pinch untuk zoom · rasio {aspect === 1 ? "1:1" : `${aspect}:1`}
                </div>
              </div>
              <button
                onClick={() => setSrcRaw(null)}
                className="smallcaps text-[10px] text-muted hover:text-ink"
              >
                batal
              </button>
            </div>

            {/* Cropper canvas */}
            <div className="relative h-[55vh] bg-ink">
              <Cropper
                image={srcRaw}
                crop={crop}
                zoom={zoom}
                rotation={rotation}
                aspect={aspect}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onRotationChange={setRotation}
                onCropComplete={onCropComplete}
                objectFit="contain"
                showGrid
                style={{
                  containerStyle: { background: "#1a1a1a" },
                  cropAreaStyle: { border: "1px solid #f7f5f0", color: "rgba(247,245,240,0.4)" },
                }}
              />
            </div>

            {/* Controls */}
            <div className="space-y-4 px-5 py-4">
              <label className="block">
                <div className="mb-1 flex items-center justify-between">
                  <span className="smallcaps text-[9px] text-muted">zoom</span>
                  <span className="text-[10px] text-muted">{zoom.toFixed(1)}×</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.05}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="w-full accent-[#1e3f20]"
                />
              </label>

              <label className="block">
                <div className="mb-1 flex items-center justify-between">
                  <span className="smallcaps text-[9px] text-muted">rotasi</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRotation((r) => r - 90)}
                      className="rounded-full border border-sand px-2 py-0.5 text-[10px] text-ink/70"
                    >
                      −90°
                    </button>
                    <span className="text-[10px] text-muted">{rotation}°</span>
                    <button
                      type="button"
                      onClick={() => setRotation((r) => r + 90)}
                      className="rounded-full border border-sand px-2 py-0.5 text-[10px] text-ink/70"
                    >
                      +90°
                    </button>
                  </div>
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={1}
                  value={rotation}
                  onChange={(e) => setRotation(Number(e.target.value))}
                  className="w-full accent-[#1e3f20]"
                />
              </label>
            </div>

            {/* Actions */}
            <div className="flex gap-3 border-t border-sand px-5 py-4">
              <button
                onClick={() => setSrcRaw(null)}
                className="rounded-full border border-sand px-5 py-3 text-[11px] tracking-[0.14em] text-ink/70 uppercase"
              >
                Batal
              </button>
              <button
                disabled={busy}
                onClick={applyCrop}
                className="flex-1 rounded-full bg-forest py-3 text-[11.5px] tracking-[0.16em] text-linen uppercase transition disabled:opacity-50"
              >
                {busy ? "Menyimpan…" : "Simpan Foto"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
