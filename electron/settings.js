'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  try {
    const s = await window.nmSettings.get();
    $('port').value = s.port || 8080;
    $('authUsername').value = s.authUsername || 'admin';
    $('dataDir').value = s.dataDir || '';
    $('roots').value = s.roots || '';
  } catch (e) {
    $('status').textContent = '读取设置失败：' + e.message;
  }

  $('save').addEventListener('click', async () => {
    const data = {
      port: $('port').value,
      authUsername: $('authUsername').value,
      password: $('password').value,
      dataDir: $('dataDir').value,
      roots: $('roots').value
    };
    if (!data.port || data.port < 1 || data.port > 65535) {
      $('status').textContent = '端口需在 1–65535 之间';
      return;
    }
    $('status').textContent = '正在保存…';
    try {
      const r = await window.nmSettings.save(data);
      if (r && r.started) {
        $('status').textContent = '已保存，正在启动服务并打开主界面…';
      } else if (r && r.applied) {
        $('status').textContent = r.portChanged
          ? '已保存，端口已切换并重新加载界面（无需重启）'
          : '已保存，设置已立即生效（无需重启）';
      } else if (r && r.restarting) {
        $('status').textContent = '数据目录已变更，程序即将重启以应用（凭据已迁移，不会丢账号）…';
      }
    } catch (e) {
      $('status').textContent = '保存失败：' + e.message;
    }
  });
})();
