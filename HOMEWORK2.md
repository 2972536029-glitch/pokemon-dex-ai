<!--
============================================================
  HOMEWORK 2 - Describe a real HTTP request from api.xsolla.com
============================================================
  Fill in the sections below and submit this file.

  Steps:
   1. Register / log in at publisher.xsolla.com and open any page.
   2. Open DevTools -> Network, filter by Fetch / XHR.
   3. Pick ONE request whose URL contains "api.xsolla.com".
   4. Fill in the fields below.

  SECURITY - redact before submitting:
   - Authorization / Cookie / Token headers  -> replace value with ***REDACTED***
   - Account, email, password, or any secret in the payload -> mask it
   - Never submit real credentials.
============================================================
-->

# Homework 2 - HTTP Request Analysis

**Name:** 余尧

## 1. Where the request came from

- Page: Publisher Account → "财务与会计"(Finance & Accounting)模块 → "交易记录"(Transaction History)页
- Action that triggered it (what you clicked / did): 点击左侧导航进入"财务与会计 → 交易记录"页面,页面加载时自动触发了这个请求(用于拉取当前商户的协议信息)。

## 2. Request fields

| Field | Value |
| --- | --- |
| Request URL | https://api.xsolla.com/merchant/current/merchants/890145/agreements |
| Method | GET |
| Status Code | 200 OK |
| Query Params? (yes/no + which) | no |
| Request Payload? (yes/no + which fields) | no |
| Authorization | Bearer ***REDACTED*** |

## 3. Request payload (if any)

```json
// 无(GET 请求不携带请求体)
```

## 4. Notes (optional)

这是一个 **GET** 请求,用于获取当前登录商户(merchant id: 890145)与 Xsolla 之间的**合作协议(agreements)**。

**请求方法分析:**
- **为什么是 GET**:获取数据用 GET,这是 RESTful 风格的标准做法。URL 用名词 `agreements` 表达"是什么资源",Method 用 `GET` 表达"做什么操作(读取)"——对应课件 Segment 4 讲的 RESTful 设计原则。
- **为什么没有 Query Params**:URL 路径 `merchants/890145/agreements` 已经精确指定了"890145 商户的协议",不需要再用 `?type=xxx&limit=xxx` 这种查询参数做额外限定。这说明该商户的协议数量不多,后端直接返回全部,无需分页或筛选。
- **为什么没有 Payload**:GET 的语义是"读取数据",只向服务器索取、不向服务器"送"数据,因此不携带请求体。对比 POST/PUT 这类写操作,它们需要把要创建/修改的字段放在 Payload 里发给服务器。

**业务场景推测:**
进入"交易记录"页时拉取 agreements,可能是因为交易记录功能依赖协议条款(如分成比例、结算周期、币种等),页面需要先拿到协议信息才能正确展示和处理交易数据。

**状态码与安全:**
- **状态码 200 OK**:服务器成功返回了协议列表的 JSON 数据。
- **认证方式**:请求通过 `Authorization: Bearer ***REDACTED***` 携带登录后服务器签发的 Token,服务器据此识别"这是商户 890145 的合法请求"。Token 等同于登录凭证,泄露后他人可直接冒用,因此已打码。URL 中的 merchant id 是资源标识,不属于敏感凭证。
