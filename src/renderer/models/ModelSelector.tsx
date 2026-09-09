import { useEffect, useState } from 'react';
import { i18nService } from '../services/i18n';

interface Model {
  id: string;
  provider: string;
  model: string;
  display_name: string | null;
  quota_per_user_per_day: number | null;
}

export function ModelSelector({ onSelect }: { onSelect: (m: Model) => void }) {
  const [list, setList] = useState<Model[]>([]);
  const [usage, setUsage] = useState<{ items: { model_id: string; used: number }[] } | null>(null);
  const t = (k: string): string => i18nService.t(k);

  useEffect(() => {
    if (!window.electron?.enterpriseMt) return;
    const bridge = window.electron!.enterpriseMt;
    bridge.getModels().then((rows) => setList(rows as Model[]));
    if (bridge.getUsageToday) {
      bridge.getUsageToday().then((u) => setUsage(u as { items: { model_id: string; used: number }[] }));
    }
  }, []);

  return (
    <div className="border p-3 rounded">
      <h3 className="font-bold mb-2">{t('enterpriseModelsTitle')}</h3>
      {list.length === 0 && (
        <p className="text-gray-500 text-sm">{t('enterpriseModelsEmpty')}</p>
      )}
      <div className="space-y-1">
        {list.map((m) => {
          const used = usage?.items.find((u) => u.model_id === m.id)?.used ?? 0;
          const quota = m.quota_per_user_per_day;
          return (
            <button
              key={m.id}
              type="button"
              className="block text-left w-full p-2 hover:bg-gray-100 rounded"
              onClick={() => onSelect(m)}
            >
              <span className="font-medium">
                {m.display_name ?? m.model}
              </span>
              {quota !== null && (
                <span className="text-xs text-gray-500 ml-2">
                  {used}/{quota} tokens
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}