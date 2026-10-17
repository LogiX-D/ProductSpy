'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, Upload, ShieldCheck, RefreshCw } from 'lucide-react';
import {
  MAX_WORKSPACE_BACKUP_BYTES,
  PRODUCTSPY_VERSION,
  errorMessage,
  parseWorkspaceBackup,
  parseWorkspaceBackupText,
  serializeWorkspaceBackup,
  type WorkspaceBackup,
  type WorkspaceBackupPreview,
} from '@productspy/shared';
import {
  exportWorkspaceBackup,
  readBackupPreferences,
  restoreBackupPreferences,
  restoreWorkspaceBackup,
  workspaceStatus,
} from '../lib/workspace-backup-api';
import { downloadLibraryFile } from '../lib/library-api';
import { OPEN_SETUP_EVENT } from './first-use-guide';
import { Button, ErrorNotice, LoadingState, PageHeading } from './ui';
import { LibraryDialog } from './library-dialog';
import './backup-workspace.css';
import { isLegacyMode } from '../lib/session';

const labels = {
  products: '商品',
  groups: '分组',
  tags: '标签',
  comparisons: '对比方案',
  templates: '用户模板',
  contentPlans: '内容方案',
  usage: 'AI 请求记录',
  histories: '历史版本',
} as const;
export function BackupWorkspace() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof workspaceStatus>>>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [includePreferences, setIncludePreferences] = useState(false);
  const [restorePreferences, setRestorePreferences] = useState(false);
  const [incoming, setIncoming] = useState<WorkspaceBackup>();
  const [preview, setPreview] = useState<WorkspaceBackupPreview>();
  const [policy, setPolicy] = useState<'skip' | 'preserve'>('skip');
  const [confirm, setConfirm] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const canceled = useRef(false);
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setStatus(await workspaceStatus());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => controller.current?.abort();
  }, []);
  async function exportBackup() {
    setBusy('正在读取并验证完整业务资料…');
    setError('');
    setNotice('');
    try {
      const backup = await exportWorkspaceBackup();
      if (includePreferences) backup.preferences = readBackupPreferences(localStorage);
      const checked = parseWorkspaceBackup(backup);
      downloadLibraryFile({
        filename: `ProductSpy-${PRODUCTSPY_VERSION}-workspace-${new Date().toISOString().slice(0, 10)}.json`,
        mimeType: 'application/json',
        content: serializeWorkspaceBackup(checked),
        count: checked.library.products.length,
      });
      setNotice(
        '完整业务备份已准备下载。请妥善保存，其中包含商品与人工编辑；不包含 API Key 或配对凭据。',
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  }
  async function selectFile(file: File) {
    setIncoming(undefined);
    setPreview(undefined);
    setError('');
    setNotice('');
    setRestorePreferences(false);
    canceled.current = false;
    setBusy('正在验证文件结构、来源及全部历史…');
    const abort = new AbortController();
    controller.current = abort;
    try {
      if (file.size > MAX_WORKSPACE_BACKUP_BYTES) throw new Error('完整业务备份不能超过 100 MiB');
      if (!file.name.toLowerCase().endsWith('.json'))
        throw new Error('请选择 ProductSpy 完整业务 JSON 备份；不接受 ZIP 或可执行文件');
      const text = await file.text();
      if (canceled.current) return;
      const backup = parseWorkspaceBackupText(text);
      const result = await restoreWorkspaceBackup(backup, {}, abort.signal);
      if (!canceled.current) {
        setIncoming(backup);
        setPreview(result.preview);
      }
    } catch (reason) {
      if (!canceled.current) setError(errorMessage(reason));
    } finally {
      controller.current = undefined;
      setBusy('');
    }
  }
  async function commitRestore() {
    if (!incoming || !preview) return;
    setConfirm(false);
    setBusy('正在安全恢复业务资料，请等待原子保存完成…');
    setError('');
    try {
      const result = await restoreWorkspaceBackup(incoming, {
        commit: true,
        confirmed: true,
        policy,
        expectedRevision: preview.revision,
      });
      let preferencesWarning = '';
      if (restorePreferences && result.preferences) {
        try {
          restoreBackupPreferences(result.preferences, localStorage);
        } catch {
          preferencesWarning = ' 浏览器偏好未能写入；业务资料已经安全恢复，可重新打开设置检查。';
        }
      }
      setIncoming(undefined);
      setPreview(undefined);
      setNotice(
        `恢复完成：新增 ${result.imported ?? 0} 条，保留已有重复记录 ${result.skipped ?? 0} 条。${preferencesWarning}`,
      );
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  }
  async function repreview() {
    if (!incoming) {
      await refresh();
      return;
    }
    setBusy('重新检查恢复预览…');
    setError('');
    try {
      const result = await restoreWorkspaceBackup(incoming, {});
      setPreview(result.preview);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="backup-workspace">
      <PageHeading
        title="设置与业务备份"
        description="统一保存业务资料，保留独立备份入口。恢复前先预览，现有资料始终优先保留。"
      />
      {error && <ErrorNotice message={error} onRetry={() => void repreview()} />}
      {notice && (
        <p className="backup-notice" role="status">
          {notice}
        </p>
      )}
      <section className="backup-section" aria-labelledby="backup-heading">
        <div className="backup-section-heading">
          <div>
            <h2 id="backup-heading">完整业务备份</h2>
            <p className="muted">
              商品、分组标签、竞品对比、用户模板、内容方案、全部历史和 AI 用量审计。
            </p>
          </div>
          <Button
            variant="ghost"
            disabled={Boolean(busy)}
            onClick={() => void refresh()}
            aria-label="刷新备份状态"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
        {loading ? (
          <LoadingState />
        ) : (
          status && (
            <>
              <dl className="backup-counts">
                {Object.entries(labels).map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{status.counts[key as keyof typeof labels]}</dd>
                  </div>
                ))}
              </dl>
              <p className="muted">
                业务文件共 {(status.bytes / 1024 / 1024).toFixed(2)} MiB。完整备份上限 100
                MiB，每类资料上限 25 MiB。
              </p>
            </>
          )
        )}
        <div className="backup-privacy">
          <ShieldCheck size={18} />
          <p>不备份 API Key、Cookie、授权令牌或支付资料。个人内容可能敏感，分享前请自行检查。</p>
        </div>
        <label className="backup-checkbox">
          <input
            type="checkbox"
            checked={includePreferences}
            disabled={Boolean(busy)}
            onChange={(event) => setIncludePreferences(event.target.checked)}
          />
          另附此浏览器的商品库、分析、创作偏好与内置模板收藏
        </label>
        <div className="backup-actions">
          <Button disabled={Boolean(busy) || !status} onClick={() => void exportBackup()}>
            <Download size={16} />
            导出完整业务备份
          </Button>
          <Button
            variant="secondary"
            disabled={Boolean(busy)}
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={16} />
            选择备份并预览恢复
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="完整业务备份文件"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void selectFile(file);
          }}
        />
        {busy && (
          <div className="backup-progress" role="status">
            <span>{busy}</span>
            {controller.current && (
              <Button
                variant="ghost"
                onClick={() => {
                  canceled.current = true;
                  controller.current?.abort();
                }}
              >
                取消验证
              </Button>
            )}
          </div>
        )}
      </section>
      {preview && incoming && (
        <section className="backup-section" aria-labelledby="restore-heading">
          <h2 id="restore-heading">恢复预览</h2>
          <p>
            备份时间：{new Date(incoming.exportedAt).toLocaleString('zh-CN')}。格式版本：
            {incoming.schemaVersion}。
          </p>
          <dl className="backup-counts">
            {Object.entries(labels).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{preview.counts[key as keyof typeof labels]}</dd>
              </div>
            ))}
          </dl>
          <p>{preview.conflicts.length} 条与已有资料重复；恢复不会覆盖已有内容。</p>
          {preview.conflicts.length > 0 && (
            <details>
              <summary>查看重复记录</summary>
              <ul>
                {preview.conflicts.slice(0, 40).map((item) => (
                  <li key={`${item.kind}:${item.id}`}>{item.label}</li>
                ))}
              </ul>
              {preview.conflicts.length > 40 && (
                <p>另有 {preview.conflicts.length - 40} 条，全部采用所选安全策略。</p>
              )}
            </details>
          )}
          <ul className="backup-warnings">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <label>
            重复处理
            <select
              value={policy}
              onChange={(event) => setPolicy(event.target.value as 'skip' | 'preserve')}
            >
              <option value="skip">跳过重复记录</option>
              <option value="preserve">保留已有资料</option>
            </select>
          </label>
          {incoming.preferences && (
            <label className="backup-checkbox">
              <input
                type="checkbox"
                checked={restorePreferences}
                onChange={(event) => setRestorePreferences(event.target.checked)}
              />
              恢复所附浏览器偏好（将替换此浏览器相应偏好）
            </label>
          )}
          <div className="backup-actions">
            <Button disabled={Boolean(busy)} onClick={() => setConfirm(true)}>
              确认恢复这份业务备份
            </Button>
            <Button
              variant="secondary"
              disabled={Boolean(busy)}
              onClick={() => {
                setIncoming(undefined);
                setPreview(undefined);
              }}
            >
              取消恢复
            </Button>
          </div>
        </section>
      )}
      {status &&
        [status.counts.comparisons, status.counts.templates, status.counts.contentPlans].some(
          (count) => count >= 180,
        ) && (
          <p className="backup-capacity-warning" role="status">
            部分资料已接近每类 200
            项上限。请先导出备份，再人工整理不再使用的方案；系统不会自动删除内容或历史。
          </p>
        )}
      <section className="backup-section">
        <h2>独立备份与覆盖范围</h2>
        <div className="backup-table-wrap">
          <table className="backup-table">
            <thead>
              <tr>
                <th>入口</th>
                <th>包含</th>
                <th>不包含</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <Link href="/products">商品库</Link>
                </td>
                <td>商品、分组标签、商品分析历史</td>
                <td>对比、模板、内容及用量</td>
              </tr>
              <tr>
                <td>
                  <Link href="/comparisons">竞品对比</Link>
                </td>
                <td>对比方案、商品快照与分析历史</td>
                <td>当前商品库和模板</td>
              </tr>
              <tr>
                <td>
                  <Link href="/templates">AI 模板</Link>
                </td>
                <td>用户模板和历史</td>
                <td>内置模板与其他业务资料</td>
              </tr>
              <tr>
                <td>
                  <Link href="/content">内容创作</Link>
                </td>
                <td>内容、商品/模板/对比快照与版本</td>
                <td>配对信息和 Key</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted">
          完整备份只保存素材 URL
          与来源元数据，不下载或复制受限图片和视频。草稿暂存只在原浏览器保留，未保存的草稿不在业务备份内。
        </p>
      </section>
      <section className="backup-section">
        <h2>连接与 AI 设置</h2>
        <p>
          {isLegacyMode
            ? 'Windows 便携版可在启动器的「AI 设置」配置 API 地址、模型与 Key。Key 保存在用户目录并由 Windows 保护，更新程序时不要清空用户数据目录。'
            : 'AI 由工作台服务端提供。账号数据保存在云端；可导出备份，也可安全导入旧 Windows 工作台的完整业务备份。账号密码、订阅和付款状态不随业务备份迁移。'}
        </p>
        <p className="muted">
          未配置 Key 时使用明确标注的 Mock 演示；真实 AI 每次需要授权，业务备份不会改变费用限制。
        </p>
        <Button
          variant="secondary"
          onClick={() => window.dispatchEvent(new Event(OPEN_SETUP_EVENT))}
        >
          {isLegacyMode ? '打开安装与安全配对' : '安装与授权 Chrome 扩展'}
        </Button>
      </section>
      {confirm && (
        <LibraryDialog title="再次确认恢复" onClose={() => setConfirm(false)}>
          <p>即将新增业务资料并保留所有已有重复记录。不会替换分析、人工编辑或历史。</p>
          {restorePreferences && <p>你已选择替换此浏览器的已附偏好。</p>}
          <p>恢复期间请等待完成；文件保存失败会回滚，异常退出会在下次读写前检查恢复日志。</p>
          <div className="backup-actions">
            <Button onClick={() => void commitRestore()}>
              {isLegacyMode ? '恢复并保留本机资料' : '恢复并保留账号资料'}
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              返回预览
            </Button>
          </div>
        </LibraryDialog>
      )}
    </div>
  );
}
