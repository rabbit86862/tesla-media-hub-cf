const HISTORY_KEY = 'tesla_vod_history_v1';
const MAX_HISTORY = 12;

window.WatchHistory = {
  getAll() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch {
      return [];
    }
  },

  getItem(vodId, sourceApi) {
    return this.getAll().find(
      item => String(item.vodId) === String(vodId) && item.sourceApi === sourceApi
    );
  },

  // 保存或更新播放进度（建议播放器每 5 秒及关闭时调用）
  save(record) {
    if (!record || !record.vodId || record.time < 5) return;
    // 若剩余时间不足 15 秒，视为已看完当前集，不记录无效尾帧
    if (record.duration > 0 && record.duration - record.time < 15) return;

    let list = this.getAll().filter(
      item => !(String(item.vodId) === String(record.vodId) && item.sourceApi === record.sourceApi)
    );
    list.unshift({
      vodId: record.vodId,
      vodName: record.vodName,
      vodPic: record.vodPic || '',
      sourceApi: record.sourceApi,
      epIndex: record.epIndex || 0,
      epName: record.epName || '第1集',
      time: Math.floor(record.time),
      duration: Math.floor(record.duration || 0),
      updatedAt: Date.now()
    });
    if (list.length > MAX_HISTORY) list = list.slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  },

  remove(vodId, sourceApi) {
    const list = this.getAll().filter(
      item => !(String(item.vodId) === String(vodId) && item.sourceApi === sourceApi)
    );
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  },

  formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
};
