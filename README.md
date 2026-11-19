# 虚拟电厂演练中自然语言调节通知的作用域

notices 使用发话人和带偏移的发送时间。resources 的容量是演练单位，offers 是协调员意向，区间含起点、不含终点。roles 给出演练参与者权限。

资料保存在 `data/inputs.json`，采用 UTF-8 JSON。记录、人员、地点和业务编号均为合成内容。

运行环境为 Node.js 22.23.4，资料工具和测试使用 Node.js 标准库。

```sh
npm run inspect:data
npm test
```

`inspect:data` 读取资料并列出记录数。测试核对该批资料的字段和引用完整性。
