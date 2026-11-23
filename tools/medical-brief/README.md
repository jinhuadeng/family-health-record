# 病历整理工具（medical-brief）

家里老人生病、要陪着看医生时，把散落在聊天记录、化验单、病历里的信息，整理成医生几分钟就能看懂的材料：

- **一页就诊沟通单**（PDF）：过敏、这次为什么来、既往史和用药、关键检查、最想问的问题
- **病程事实时间线**（PDF + Excel）：逐日事实、用药、待核实事项、检验明细，异常项标红
- **动态血糖汇总**（PDF，可选）：分时段汇总表、目标对照、App 截图

只整理事实，不做诊断。

## 用法

```bash
pip install openpyxl
python brief.py sample/patient.json out
```

需要本机装有 Chrome、Edge 或 Chromium，用来把页面打印成 PDF。找不到时，用环境变量 `CHROME` 指定路径。

## 填自己的资料

1. 复制 `sample/patient.json`，按里面的格式填写。
2. 文本里可以用 `**加粗**`。
3. 血糖截图放在 JSON 同一目录，在 `cgm.images[].files` 里写文件名。不需要血糖页就删掉 `cgm`。
4. 示例截图由 `make_sample_images.py` 生成（在 `sample/` 目录里运行）。

## 隐私

- **不要把家人的真实资料提交到公开仓库。**仓库的 `.gitignore` 已经忽略 `out/` 和 `private/`，真实资料请放在 `private/` 里。
- 截图前先裁掉手机号、身份证号、住院号等个人信息。
