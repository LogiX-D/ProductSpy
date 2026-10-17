import { APP_URL, LEGACY_MODE } from '../config';

const legacyCopy = {
  brand: 'ProductSpy',
  header: { subtitle: '商品采集 · 本机素材库' },
  consent: {
    checking: '正在读取本机设置…',
    title: '首次采集说明',
    capture:
      '点击同意后，ProductSpy 仅在你打开扩展时读取当前 Amazon 商品的标题、价格、ASIN、商品链接、品牌、图片、可靠匹配的视频、卖点、描述、评分和评分数量。',
    storage:
      '点击保存，商品资料存入你自己的本机工作台；断线时先暂存在扩展。不会读取浏览历史、Amazon 登录凭据或支付信息。',
    analysis:
      '演示分析完全在本机运行。只有你配置真实 AI 并点击分析时，选定商品的文字资料才会发送至你配置的 AI 服务商。',
    accept: '同意并开始采集',
    saving: '正在保存设置…',
    readError:
      '无法读取本机同意设置，或读取已超时。尚未读取商品页面。请重新打开扩展，或再次同意后继续。',
    saveError:
      '无法确认本机同意设置已保存，可能保存失败或超时。尚未读取商品页面，请点击「同意并开始采集」重试。',
  },
  capture: {
    loading: '正在读取 Amazon 商品…',
    loadingDetail: '识别基本资料与公开媒体',
    captured: '商品已采集',
    unsupported: '请打开 Amazon 商品详情页',
    unsupportedDetail: '打开商品详情页并等待加载完成，再点击「重新识别」。',
    error: '暂时无法识别商品',
    errorDetail: '等待页面加载完成后，点击「重新识别」；也可刷新页面后重试。',
    retry: '重新识别',
    fallbackError: '读取商品失败，请重试。',
    connectionError: '插件连接失败，请重新打开插件。',
  },
  workspace: {
    connected: '工作台已连接',
    pairedOffline: '已配对 · 工作台暂不可用',
    unpaired: '尚未配对工作台',
    offline: '工作台暂不可用 · 尚未配对',
    checking: '正在检查工作台连接…',
    setup: '连接设置',
    pairHint:
      '在工作台「安装与配对」生成配对码，再粘贴到下方。有效期 2 分钟，过期或已使用请重新生成。',
    offlineHint: '双击便携包中的 ProductSpy.cmd，待工作台打开后重试。商品可以先暂存于扩展。',
    connectedHint: '商品会保存至本机工作台，分析也在工作台中操作。',
    pairLabel: '工作台配对码',
    pairPlaceholder: '粘贴工作台生成的配对码',
    pair: '连接工作台',
    pairing: '正在连接…',
    recheck: '重新检查连接',
    open: '打开工作台',
    invalidStatus: '工作台状态无效',
  },
  product: {
    priceUnavailable: '价格暂不可用',
    asin: 'ASIN',
    images: '图片',
    videos: '视频',
    rating: '评分',
    reviews: '评论',
    imageUnavailable: '暂无可用商品图片',
  },
  actions: {
    save: '保存到素材库',
    update: '更新素材库',
    retrySave: '重试保存',
    saving: '正在保存…',
    analyze: '保存并分析',
    openAnalysis: '打开分析',
    openingAnalysis: '正在打开…',
    savingForAnalysis: '正在保存并打开…',
    sync: '重试同步',
    syncing: '正在同步…',
  },
  analysis: {
    mock: '当前为本机演示分析；在工作台配置 AI 服务可切换。',
    real: '打开分析页后，由你在工作台开始 AI 分析。',
    unknown: '先保存商品，再到工作台选择分析方式。',
  },
  feedback: {
    saved: '已保存到素材库，同一 ASIN 会自动更新。',
    pending: '已暂存在扩展中，连接工作台后可同步。',
    pendingAnalysis: '商品已暂存；同步到工作台后，即可打开分析。',
    analysisOpened: '已打开分析页，请在工作台开始分析。',
    paired: '配对成功，现在可以保存和同步商品。',
    synced: (count: number) => `已同步 ${count} 件商品到素材库。`,
    pendingCount: (count: number) => `${count} 件商品待同步`,
    saveError: '保存失败，请重试。',
    analysisError: '无法打开分析页，请点击「打开分析」重试。',
  },
  privacy: {
    label: '隐私说明',
    summary: '仅读取当前商品，保存至本机；真实 AI 分析会发送商品文字至你配置的服务。',
    url: 'https://github.com/LogiX-D/ProductSpy/blob/main/PRIVACY.md',
  },
} as const;

export const popupCopy = LEGACY_MODE
  ? legacyCopy
  : {
      ...legacyCopy,
      header: { subtitle: '商品采集 · 在线 SaaS 工作台' },
      consent: {
        ...legacyCopy.consent,
        storage:
          '点击保存后，商品资料通过云端 API 上传至你的 ProductSpy 账号。网络异常时保存在插件当前账号的队列，恢复后自动重试。未登录和旧版本记录不会自动归入新账号。不会读取浏览历史、Amazon 登录凭据或支付信息。',
        analysis:
          'AI 分析由你在在线工作台发起。选定商品的文字资料将由云端提交至已配置的 AI 服务商；请先查看在线工作台的隐私说明。',
      },
      workspace: {
        ...legacyCopy.workspace,
        connected: 'SaaS 账号已登录',
        pairedOffline: '已登录 · 云端暂不可用',
        unpaired: '请登录并授权插件',
        offline: '云端暂不可用 · 未登录',
        checking: '正在检查云端连接…',
        setup: '账号与连接',
        pairHint:
          '打开在线工作台并登录，在设置中输入下方插件 ID 生成一次性授权码，再粘贴到这里。授权码 2 分钟内有效且仅可使用一次。',
        offlineHint:
          '请检查网络后重试。当前账号的待同步商品会保留，并在恢复网络后重试；最多自动重试 8 次。',
        connectedHint:
          '商品同步至此账号。登录授权最长有效 30 天，到期或撤销后需重新授权。退出会保留此账号的离线队列。',
        pairLabel: '一次性登录授权码',
        pairPlaceholder: '粘贴网页生成的授权码',
        pair: '登录插件',
        pairing: '正在授权…',
      },
      analysis: {
        mock: '在在线工作台发起分析；演示与真实 AI 结果会明确标识。',
        real: '打开在线分析页后，由你开始 AI 分析。',
        unknown: '先保存商品，再到在线工作台发起分析。',
      },
      feedback: {
        ...legacyCopy.feedback,
        pending: '商品已暂存在插件队列中，登录并连接云端后可同步。',
        paired: '登录授权成功，当前账号的队列将恢复同步。',
      },
      privacy: {
        ...legacyCopy.privacy,
        summary: '仅读取当前商品；保存后同步至你的云端账号。AI 分析由你在工作台发起。',
        url: `${APP_URL}/privacy`,
      },
    };
