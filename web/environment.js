function environmentChoice(root, label, choices, value, change) {
  const select = formField(root, label, "select"); select.required = false;
  for (const [id, name] of choices) { const option = element("option", "", name); option.value = id; select.append(option); }
  select.value = value;
  select.addEventListener("change", () => change(select.value));
  return select;
}

function scannedServices(scan, target) {
  const apps = scan.services.filter(row => row.kind === "application" && (target === "all"
    || target === "frontend" && row.role === "frontend" || row.id === target));
  return scan.services.filter(row => apps.includes(row) || row.owners?.some(id => apps.some(app => app.id === id)));
}

function renderScanEvidence(root, item) {
  const details = element("details", "environment-evidence");
  details.append(element("summary", "", "查看判断依据"), element("p", "plain-copy", item.reason));
  for (const source of item.evidence ?? []) details.append(element("p", "environment-source", source));
  root.append(details);
}

function renderScannedField(root, service, field, draft, controls) {
  const key = `${service.id}/${field.key}`; const row = element("div", "environment-field");
  let valueLabel;
  if (field.requirement === "unknown") environmentChoice(row, `${field.label} · 是否必需`,
    [["pending", "待研发确认"], ["enabled", "本次必需"], ["disabled", "本次不用"]], draft.decisions[key] ?? "pending", choice => {
      draft.decisions[key] = choice; valueLabel.hidden = choice === "disabled";
    });
  const input = formField(row, `${field.label}${field.requirement === "required" ? " · 必需" : field.requirement === "optional" ? " · 可选" : ""}`,
    "input", field.secret && draft.setup.secretConfigured[key] ? "已配置，留空保持" : "填写验证环境的配置");
  input.required = false; input.type = field.secret ? "password" : field.type === "port" ? "number" : "text";
  input.autocomplete = field.secret ? "new-password" : "off"; input.value = draft.values[key] ?? "";
  valueLabel = input.parentElement; valueLabel.hidden = field.requirement === "unknown" && draft.decisions[key] === "disabled";
  if (field.type === "port") { input.min = "1"; input.max = "65535"; }
  controls.set(key, input);
  if (field.reference !== undefined && !field.secret) {
    const reference = element("button", "environment-reference", `项目参考：${field.reference} · 点击采用`); reference.type = "button";
    reference.addEventListener("click", () => { input.value = field.reference; draft.values[key] = field.reference; }); row.append(reference);
  }
  if (field.reason) renderScanEvidence(row, field);
  root.append(row);
}

function renderScannedService(root, service, draft, controls) {
  const card = element("section", "environment-service");
  const heading = element("div", "environment-service-heading");
  heading.append(element("h3", "", service.name), element("span", `environment-necessity ${service.requirement}`,
    { required: "必需", optional: "可选", unknown: "待确认" }[service.requirement])); card.append(heading);
  if (service.owners?.length) card.append(element("p", "plain-copy", `供 ${service.owners.map(id => draft.scan.services.find(row => row.id === id).name).join("、")} 使用`));
  const fields = element("div", "environment-fields");
  const optional = element("details", "environment-optional"); const optionalFields = element("div", "environment-fields");
  if (service.requirement !== "required") {
    const initial = draft.decisions[service.id] ?? (service.requirement === "optional" ? "disabled" : "pending");
    environmentChoice(card, "本次使用", [["pending", "待研发确认"], ["enabled", "需要，配置此服务"], ["disabled", "本次不用"]], initial,
      choice => { draft.decisions[service.id] = choice; fields.hidden = choice !== "enabled"; optional.hidden = choice !== "enabled"; });
    fields.hidden = initial !== "enabled";
    optional.hidden = initial !== "enabled";
  }
  if (service.kind === "application") for (const effect of service.effects) card.append(element("p", "environment-effect", effect));
  for (const error of service.scanErrors ?? []) card.append(element("p", "environment-blocked", error));
  renderScanEvidence(card, service);
  optional.append(element("summary", "", "可选配置"), optionalFields);
  for (const field of service.fields) renderScannedField(field.requirement === "optional" ? optionalFields : fields, service, field, draft, controls);
  card.append(fields);
  if (optionalFields.children.length) card.append(optional);
  if (!service.fields.length) card.append(element("p", "plain-copy", "未发现需填写的环境变量。"));
  root.append(card);
}

function renderEnvironmentDiff(root, draft) {
  const changed = draft.setup.settings?.scan && draft.setup.settings.scan.hash !== draft.scan.hash;
  if (!changed) return null;
  const panel = element("div", "environment-diff"); panel.append(element("h3", "", "扫描发现变化，确认后应用"));
  for (const [key, label] of [["added", "新增"], ["removed", "移除"], ["changed", "变化"]])
    if (draft.diff[key].length) panel.append(element("p", "plain-copy", `${label}：${draft.diff[key].join("、")}`));
  panel.append(element("p", "plain-copy", "保留已填写内容和历史版本；移除项不再注入服务。"));
  const label = element("label", "environment-confirm"); const input = element("input", ""); input.type = "checkbox";
  label.append(input, document.createTextNode("我已查看差异，应用本次扫描")); panel.append(label); root.append(panel);
  return input;
}

async function renderScannedEnvironment(root, projectId, request) {
  const response = await api("/api/local-environment-scan");
  if (state.currentProjectId !== projectId || request !== state.environmentRequest) return;
  const draft = { ...response, target: response.setup.settings?.target ?? "all", values: { ...response.setup.values },
    decisions: { ...response.setup.settings?.decisions }, environmentFile: "" };
  const editor = element("form", "environment-editor"); root.append(editor);
  let controls = new Map(); let importInput; let busy = false;
  const collect = () => { for (const [key, input] of controls) draft.values[key] = input.value;
    if (importInput) draft.environmentFile = importInput.value; };
  const current = () => state.currentProjectId === projectId && request === state.environmentRequest;
  const rescan = async taskId => {
    if (busy) return; collect(); busy = true; editor.inert = true;
    try {
      const next = await api(`/api/local-environment-scan?taskId=${encodeURIComponent(taskId ?? "")}`);
      if (!current()) return;
      if (next.setup.revision !== draft.setup.revision) throw new Error("配置已由他人修改，请重新打开环境页后核对。");
      Object.assign(draft, { scan: next.scan, scanTaskId: next.scanTaskId, diff: next.diff });
      if (!["all", "frontend", ...draft.scan.services.map(row => row.id)].includes(draft.target)) draft.target = "all";
      render();
    } catch (error) { toast(error.message, true); } finally { busy = false; editor.inert = false; }
  };
  const render = () => {
    clear(editor); controls = new Map();
    const toolbar = element("div", "environment-toolbar");
    environmentChoice(toolbar, "扫描来源", draft.sources.map(row => [row.id, row.name]), draft.scanTaskId ?? "", id => rescan(id));
    const apps = draft.scan.services.filter(row => row.kind === "application");
    const frontendCount = apps.filter(row => row.role === "frontend").length;
    const targets = [["all", "完整应用"], ...(apps.some(row => row.role === "frontend") ? [["frontend", "仅前端"]] : []),
      ...apps.filter(row => row.role !== "frontend" || frontendCount > 1).map(row => [row.id, row.name])];
    environmentChoice(toolbar, "启动目标", targets, draft.target, target => { collect(); draft.target = target; render(); });
    const scan = element("button", "button", "重新扫描"); scan.type = "button";
    scan.addEventListener("click", () => rescan(draft.scanTaskId)); toolbar.append(scan); editor.append(toolbar);
    editor.append(element("p", "plain-copy", `扫描于 ${dateText(draft.scan.scannedAt)} · 已保存 v${draft.setup.version}。参考地址需点击采用，密码仅显示配置状态。`));
    const confirmation = renderEnvironmentDiff(editor, draft);
    for (const warning of draft.scan.warnings) editor.append(element("p", "environment-effect", warning));
    const services = element("div", "environment-service-list");
    for (const service of scannedServices(draft.scan, draft.target)) renderScannedService(services, service, draft, controls);
    editor.append(services);
    renderEnvironmentSave(editor, draft, confirmation, collect, current, () => busy, value => { busy = value; editor.inert = value; });
    const advanced = element("details", "environment-advanced"); advanced.append(element("summary", "", "高级选项 · 导入配置文件"));
    importInput = formField(advanced, "工作台设备上的 dotenv 文件绝对路径", "input", "/absolute/path/project.env");
    importInput.required = false; importInput.value = draft.environmentFile;
    advanced.append(element("p", "plain-copy", "文件须在项目目录外，仅导入已扫描变量；保存后使用私有副本，不持续读取原文件。")); editor.append(advanced);
    if (draft.scan.pipelines.length) editor.append(element("p", "plain-copy", `发现测试流水线：${draft.scan.pipelines.join("、")}。请在测试环境卡片连接对应发布工具。`));
  };
  render();
}

function renderEnvironmentSave(editor, draft, confirmation, collect, current, isBusy, setBusy) {
  const actions = element("div", "environment-actions"); const save = element("button", "button primary", "保存私有配置"); save.type = "submit";
  actions.append(save, element("span", "plain-copy", "保存草稿后检查环境，再从需求启动验证。")); editor.append(actions);
  editor.onsubmit = async event => {
    event.preventDefault(); if (isBusy()) return;
    if (!current()) return toast("项目已切换，请重新打开环境页。", true);
    collect();
    if (confirmation && !confirmation.checked) return toast("请查看并确认扫描差异。", true);
    const fields = new Set(draft.scan.services.flatMap(service => service.fields.map(field => `${service.id}/${field.key}`)));
    const decisionKeys = new Set(draft.scan.services.filter(service => service.requirement !== "required").map(service => service.id));
    for (const service of draft.scan.services) for (const field of service.fields) if (field.requirement === "unknown") decisionKeys.add(`${service.id}/${field.key}`);
    setBusy(true); save.disabled = true;
    try {
      await api("/api/local-environment", { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
        body: JSON.stringify({ expectedRevision: draft.setup.revision, expectedScanHash: draft.scan.hash, scanTaskId: draft.scanTaskId,
          target: draft.target, decisions: Object.fromEntries(Object.entries(draft.decisions).filter(([key]) => decisionKeys.has(key))),
          values: Object.fromEntries(Object.entries(draft.values).filter(([key]) => fields.has(key))), environmentFile: draft.environmentFile.trim(),
          acceptScanChanges: Boolean(confirmation?.checked) }) });
      if (current()) { await refresh(); toast("私有配置已保存，历史记录已保留。请检查后从需求启动验证。"); }
    } catch (error) { toast(error.message, true); } finally { setBusy(false); save.disabled = false; }
  };
}
