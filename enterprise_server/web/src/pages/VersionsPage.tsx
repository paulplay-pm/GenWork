import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, Plus, Power, PowerOff, Trash2, UploadCloud } from 'lucide-react';
import type { Dispatch, JSX, SetStateAction } from 'react';
import { useMemo, useState } from 'react';

import {
  type InstallerMeta,
  InstallerUploadError,
  type ResumeState,
  uploadInstaller,
} from '../api/releaseInstallers';
import { type ReleaseInstallers, releasesApi, type ReleaseView } from '../api/releases';
import { useAuthStore } from '../auth/store';
import { useAuth } from '../auth/useAuth';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { type Column, DataTable } from '../components/DataTable';
import { FormDrawer } from '../components/FormDrawer';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';

// field name constants — exported for tests
export const FIELD = {
  version: 'version',
  publishedAt: 'publishedAt',
  changeLogZhTitle: 'changeLogZhTitle',
  changeLogZhContent: 'changeLogZhContent',
  changeLogEnTitle: 'changeLogEnTitle',
  changeLogEnContent: 'changeLogEnContent',
} as const;

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function humanizeSize(bytes: number): string {
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${SIZE_UNITS[i]}`;
}

interface UploadProgressShape {
  done: number;
  total: number;
}

/** Per-platform installer uploader state. `done` carries no `File` when the
 * drawer is opened in edit mode (the existing installer was pre-populated
 * from the release view, not picked locally). */
type Uploader =
  | { status: 'idle' }
  | { status: 'uploading'; progress: UploadProgressShape; file: File }
  | { status: 'done'; meta: InstallerMeta }
  | { status: 'error'; message: string; file: File; resume?: ResumeState };

export function VersionsPage(): JSX.Element {
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? 'default-org';
  const qc = useQueryClient();
  const toast = useToast();

  const { data } = useQuery<ReleaseView[]>({
    queryKey: ['releases', orgId],
    queryFn: () => releasesApi.list(orgId),
  });
  const releases = useMemo<ReleaseView[]>(
    () => (Array.isArray(data) ? data : []),
    [data]
  );

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ReleaseView | null>(null);
  const [setLatestId, setSetLatestId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [macUploader, setMacUploader] = useState<Uploader>({ status: 'idle' });
  const [winUploader, setWinUploader] = useState<Uploader>({ status: 'idle' });

  const getToken = (): string | null => useAuthStore.getState().token ?? null;

  const runUpload = async (
    platform: 'macArm' | 'windowsX64',
    file: File,
    resume: ResumeState | undefined,
    set: Dispatch<SetStateAction<Uploader>>,
  ): Promise<void> => {
    set({ status: 'uploading', progress: { done: 0, total: file.size }, file });
    try {
      const meta = await uploadInstaller({
        platform,
        file,
        getToken,
        resume,
        onProgress: (p) =>
          set((prev) => (prev.status === 'uploading' ? { ...prev, progress: p } : prev)),
      });
      set({ status: 'done', meta });
      toast.success(t('page.versions.installerUploaded'));
    } catch (e) {
      const err =
        e instanceof InstallerUploadError ? e : new InstallerUploadError((e as Error).message);
      set({ status: 'error', message: err.message, file, resume: err.resume });
      toast.error(err.message);
    }
  };

  const addMut = useMutation({
    mutationFn: (input: Parameters<typeof releasesApi.add>[0]) => releasesApi.add(input),
    onSuccess: () => {
      toast.success(t('page.versions.successAdded'));
      qc.invalidateQueries({ queryKey: ['releases', orgId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof releasesApi.update>[1] }) =>
      releasesApi.update(id, patch),
    onSuccess: () => {
      toast.success(t('page.versions.successUpdated'));
      qc.invalidateQueries({ queryKey: ['releases', orgId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const setLatestMut = useMutation({
    mutationFn: (id: string) => releasesApi.setLatest(id),
    onSuccess: () => {
      toast.success(t('page.versions.successSetLatest'));
      qc.invalidateQueries({ queryKey: ['releases', orgId] });
      setSetLatestId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => releasesApi.remove(id),
    onSuccess: () => {
      toast.success(t('page.versions.successDeleted'));
      qc.invalidateQueries({ queryKey: ['releases', orgId] });
      setDeleteId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleEnabledMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      releasesApi.update(id, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['releases', orgId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openCreate = (): void => {
    setEditing(null);
    setMacUploader({ status: 'idle' });
    setWinUploader({ status: 'idle' });
    setDrawerOpen(true);
  };

  const openEdit = (r: ReleaseView): void => {
    setEditing(r);
    setMacUploader(
      r.installers.macArm
        ? { status: 'done', meta: r.installers.macArm }
        : { status: 'idle' }
    );
    setWinUploader(
      r.installers.windowsX64
        ? { status: 'done', meta: r.installers.windowsX64 }
        : { status: 'idle' }
    );
    setDrawerOpen(true);
  };

  const initialValues = useMemo<Record<string, string>>(() => {
    if (!editing) return {} as Record<string, string>;
    return {
      [FIELD.version]: editing.version,
      [FIELD.publishedAt]: editing.published_at.slice(0, 10),
      [FIELD.changeLogZhTitle]: editing.change_log.zh?.title ?? '',
      [FIELD.changeLogZhContent]: editing.change_log.zh?.content.join('\n') ?? '',
      [FIELD.changeLogEnTitle]: editing.change_log.en?.title ?? '',
      [FIELD.changeLogEnContent]: editing.change_log.en?.content.join('\n') ?? '',
    };
  }, [editing]);

  const onSubmit = async (values: Record<string, string>): Promise<void> => {
    const v = (k: string): string => values[k] ?? '';
    const parseMulti = (s: string): string[] =>
      s.split('\n').map((x) => x.trim()).filter(Boolean);
    const changeLog: {
      zh?: { title: string; content: string[] };
      en?: { title: string; content: string[] };
    } = {};
    if (v(FIELD.changeLogZhTitle) || v(FIELD.changeLogZhContent)) {
      changeLog.zh = {
        title: v(FIELD.changeLogZhTitle),
        content: parseMulti(v(FIELD.changeLogZhContent)),
      };
    }
    if (v(FIELD.changeLogEnTitle) || v(FIELD.changeLogEnContent)) {
      changeLog.en = {
        title: v(FIELD.changeLogEnTitle),
        content: parseMulti(v(FIELD.changeLogEnContent)),
      };
    }
    const installers: ReleaseInstallers = {};
    if (macUploader.status === 'done') installers.macArm = macUploader.meta;
    if (winUploader.status === 'done') installers.windowsX64 = winUploader.meta;

    const publishedAtRaw = v(FIELD.publishedAt).trim();
    const publishedAt =
      publishedAtRaw && !Number.isNaN(Date.parse(publishedAtRaw)) ? publishedAtRaw : undefined;

    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, patch: { changeLog, installers } });
      } else {
        if (!installers.macArm && !installers.windowsX64) {
          throw new Error(t('page.versions.noInstaller'));
        }
        await addMut.mutateAsync({
          orgId,
          version: v(FIELD.version).trim(),
          published_at: publishedAt,
          changeLog,
          installers,
        });
      }
    } catch (e) {
      // Re-throw so FormDrawer.submit() enters its catch path and calls setErr(e.message).
      // The mutations' onError handlers still surface the toast.
      throw e instanceof Error ? e : new Error(String(e));
    }
  };

  const fields = [
    {
      name: FIELD.version,
      label: t('page.versions.version'),
      type: 'text' as const,
      required: true,
      placeholder: '1.0.0',
    },
    ...(editing
      ? []
      : [
          {
            name: FIELD.publishedAt,
            label: t('page.versions.publishedAt'),
            type: 'text' as const,
          },
        ]),
    {
      name: FIELD.changeLogZhTitle,
      label: t('page.versions.changeLogZhTitle'),
      type: 'text' as const,
    },
    {
      name: FIELD.changeLogZhContent,
      label: t('page.versions.changeLogZhContent'),
      type: 'textarea' as const,
      rows: 4,
    },
    {
      name: FIELD.changeLogEnTitle,
      label: t('page.versions.changeLogEnTitle'),
      type: 'text' as const,
    },
    {
      name: FIELD.changeLogEnContent,
      label: t('page.versions.changeLogEnContent'),
      type: 'textarea' as const,
      rows: 4,
    },
  ];

  const columns: Column<ReleaseView>[] = [
    {
      key: 'version',
      header: t('page.versions.version'),
      render: (r) => <span className="font-medium">{r.version}</span>,
    },
    {
      key: 'published_at',
      header: t('page.versions.publishedAt'),
      render: (r) => r.published_at.slice(0, 10),
    },
    {
      key: 'is_latest',
      header: '',
      render: (r) =>
        r.is_latest ? <Badge tone="info">{t('page.versions.latestBadge')}</Badge> : null,
    },
    {
      key: 'enabled',
      header: '',
      render: (r) =>
        r.enabled ? (
          <Badge tone="success">{t('page.versions.enabledBadge')}</Badge>
        ) : (
          <Badge tone="neutral">{t('page.versions.disabledBadge')}</Badge>
        ),
    },
    {
      key: 'installers',
      header: t('page.versions.columnInstallers'),
      render: (r) => {
        const present = [
          r.installers.macArm ? 'macOS arm' : null,
          r.installers.windowsX64 ? 'Win x64' : null,
        ].filter(Boolean);
        const title = [
          r.installers.macArm ? `macOS: ${r.installers.macArm.fileName}` : null,
          r.installers.windowsX64 ? `Windows: ${r.installers.windowsX64.fileName}` : null,
        ].filter(Boolean).join('\n');
        return (
          <span title={title}>
            {present.length ? present.join(' · ') : t('page.versions.noInstaller')}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex gap-1">
          <button
            className="p-1 hover:bg-[var(--bg-hover)] rounded"
            onClick={() => openEdit(r)}
            aria-label="Edit"
          >
            <Edit3 className="h-4 w-4" />
          </button>
          {!r.is_latest && (
            <button
              className="p-1 hover:bg-[var(--bg-hover)] rounded"
              onClick={() => setSetLatestId(r.id)}
              aria-label={t('page.versions.latestBadge')}
            >
              <UploadCloud className="h-4 w-4" />
            </button>
          )}
          <button
            className="p-1 hover:bg-[var(--bg-hover)] rounded"
            onClick={() =>
              toggleEnabledMut.mutate({ id: r.id, enabled: !r.enabled })
            }
            aria-label={r.enabled ? t('page.versions.enabledBadge') : t('page.versions.disabledBadge')}
            title={r.enabled ? t('page.versions.enabledBadge') : t('page.versions.disabledBadge')}
          >
            {r.enabled ? (
              <Power className="h-4 w-4" />
            ) : (
              <PowerOff className="h-4 w-4" />
            )}
          </button>
          <button
            className="p-1 hover:bg-[var(--bg-hover)] rounded text-[var(--danger-primary)]"
            onClick={() => setDeleteId(r.id)}
            aria-label="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title={t('page.versions.title')}
        actions={
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-primary)] text-white px-3 py-2 text-sm"
            onClick={openCreate}
          >
            <Plus className="h-4 w-4" /> {t('page.versions.addButton')}
          </button>
        }
      />
      <DataTable<ReleaseView>
        columns={columns}
        rows={releases}
        rowKey={(r) => r.id}
      />
      <FormDrawer
        open={drawerOpen}
        title={editing ? t('page.versions.editTitle') : t('page.versions.addButton')}
        fields={fields}
        initialValues={initialValues}
        onSubmit={(v) => onSubmit(v as Record<string, string>)}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
          setMacUploader({ status: 'idle' });
          setWinUploader({ status: 'idle' });
        }}
      >
        {editing && (
          <div className="mb-3">
            <div className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
              {t('page.versions.publishedAt')}
            </div>
            <div className="text-sm text-[var(--text-primary)]">
              {editing.published_at.slice(0, 10)}
            </div>
          </div>
        )}
        <InstallerUploaders
          macLabel={t('page.versions.installerMacArm')}
          winLabel={t('page.versions.installerWindowsX64')}
          uploading={t('page.versions.installerUploading')}
          uploaded={t('page.versions.installerUploaded')}
          replace={t('page.versions.installerReplace')}
          error={t('page.versions.installerError')}
          retry={t('page.versions.installerRetry')}
          mac={macUploader}
          win={winUploader}
          onPickMac={(f) => void runUpload('macArm', f, undefined, setMacUploader)}
          onPickWin={(f) => void runUpload('windowsX64', f, undefined, setWinUploader)}
          onRetryMac={() => {
            if (macUploader.status === 'error') {
              void runUpload('macArm', macUploader.file, macUploader.resume, setMacUploader);
            }
          }}
          onRetryWin={() => {
            if (winUploader.status === 'error') {
              void runUpload('windowsX64', winUploader.file, winUploader.resume, setWinUploader);
            }
          }}
        />
      </FormDrawer>
      <ConfirmDialog
        open={setLatestId !== null}
        title={t('page.versions.setLatestConfirmTitle')}
        message={t('page.versions.setLatestConfirmMessage')}
        onConfirm={async () => {
          if (setLatestId) await setLatestMut.mutateAsync(setLatestId);
        }}
        onCancel={() => setSetLatestId(null)}
      />
      <ConfirmDialog
        open={deleteId !== null}
        title={t('page.versions.deleteConfirmTitle')}
        message={t('page.versions.deleteConfirmMessage')}
        destructive
        onConfirm={async () => {
          if (deleteId) await deleteMut.mutateAsync(deleteId);
        }}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}

function InstallerUploaders(props: {
  macLabel: string;
  winLabel: string;
  uploading: string;
  uploaded: string;
  replace: string;
  error: string;
  retry: string;
  mac: Uploader;
  win: Uploader;
  onPickMac: (f: File) => void;
  onPickWin: (f: File) => void;
  onRetryMac: () => void;
  onRetryWin: () => void;
}): JSX.Element {
  const row = (
    label: string,
    accept: string,
    up: Uploader,
    onPick: (f: File) => void,
    onRetry: () => void
  ): JSX.Element => {
    const meta = up.status === 'done' ? up.meta : undefined;
    const pct =
      up.status === 'uploading' && up.progress.total
        ? Math.round((up.progress.done / up.progress.total) * 100)
        : undefined;
    return (
      <div className="mb-3">
        <div className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
          {label}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="file"
            accept={accept}
            aria-label={label}
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Reset value so re-selecting the same filename still fires onChange.
              e.currentTarget.value = '';
              if (f) onPick(f);
            }}
            className="text-[12px] text-[var(--text-secondary)] file:mr-2.5 file:rounded-[6px] file:border-0 file:bg-[var(--accent-primary)]/10 file:px-3 file:py-1.5 file:text-[12px] file:text-[var(--accent-primary)]"
          />
          {up.status === 'uploading' && (
            <span className="text-sm text-[var(--text-secondary)]">
              {props.uploading} {pct != null ? `${pct}%` : ''}
            </span>
          )}
          {up.status === 'done' && (
            <span className="text-sm text-[var(--success-primary)]" title={meta?.sha256}>
              {props.uploaded}: {meta?.fileName} ({meta ? humanizeSize(meta.fileSize) : ''})
            </span>
          )}
          {up.status === 'error' && (
            <span className="text-sm text-[var(--danger-primary)]">
              {props.error}: {up.message}
            </span>
          )}
          {up.status === 'error' && (
            <button
              type="button"
              className="px-2 py-1 text-sm rounded bg-[var(--accent-primary)] text-white"
              onClick={onRetry}
            >
              {props.retry}
            </button>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="mb-4">
      {row(props.macLabel, '.dmg', props.mac, props.onPickMac, props.onRetryMac)}
      {row(props.winLabel, '.exe', props.win, props.onPickWin, props.onRetryWin)}
    </div>
  );
}
