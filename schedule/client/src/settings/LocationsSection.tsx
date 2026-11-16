import { useState } from "react";
import type { LocationData } from "../types";
import { newRowId, Section, type SectionCtx } from "./shared";

/** Locations: this app's own master (DESIGN schedule 4.5.1). */
export function LocationsSection({ ctx }: { ctx: SectionCtx }) {
  const { defs, api, run, busy, deleteButton, setDefs } = ctx;
  const locations = defs?.locations ?? [];
  const [form, setForm] = useState<{
    id: string | null;
    name: string;
    kind: string;
    sort: string;
    isActive: boolean;
  } | null>(null);

  return (
    <Section title="場所">
      <ul className="settings-list">
        {locations.map((location) => (
          <li key={location.id}>
            <span>
              {location.name}
              {location.kind && <span className="dim">（{location.kind}）</span>}
              {location.isActive === false && <span className="dim">（停止中）</span>}
            </span>{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setForm({
                  id: location.id,
                  name: location.name,
                  kind: location.kind ?? "",
                  sort: String(location.sort),
                  isActive: location.isActive !== false,
                })
              }
            >
              編集
            </button>{" "}
            {deleteButton(`location:${location.id}`, "削除", async () => {
              await api.deleteLocation({ id: location.id });
              setDefs((current) =>
                current
                  ? { ...current, locations: current.locations.filter((l) => l.id !== location.id) }
                  : current,
              );
            })}
          </li>
        ))}
      </ul>
      {form === null && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            setForm({
              id: null,
              name: "",
              kind: "",
              sort: String(locations.length + 1),
              isActive: true,
            })
          }
        >
          場所を追加
        </button>
      )}
      {form && (
        <div className="settings-form">
          <label>
            場所の名前{" "}
            <input
              aria-label="場所の名前"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            種別{" "}
            <input
              aria-label="場所の種別"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            />
          </label>
          <label>
            並び順{" "}
            <input
              aria-label="場所の並び順"
              type="number"
              value={form.sort}
              onChange={(e) => setForm({ ...form, sort: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />{" "}
            使用中
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved: LocationData = await api.upsertLocation({
                      id: form.id ?? newRowId("loc"),
                      name: form.name,
                      kind: form.kind || null,
                      sort: Number(form.sort) || 0,
                      isActive: form.isActive,
                    });
                    setDefs((current) =>
                      current
                        ? {
                            ...current,
                            locations: [
                              ...current.locations.filter((l) => l.id !== saved.id),
                              saved,
                            ].sort((a, b) => a.sort - b.sort),
                          }
                        : current,
                    );
                  },
                  () => setForm(null),
                )
              }
            >
              場所を保存
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
