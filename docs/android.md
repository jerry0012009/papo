# Papo Android

## 单一代码库

Papo 的网页与 APK 共用 `src/web`、`src/server` 和同一组 API。Capacitor 把生产 Web 构建放入 APK；`android/` 只包含 Android 必须提供的能力：

- 前台服务持续持有麦克风，并在“陪我+看我”模式按窗口调用前置或后置相机
- Android Keystore 加密短期设备令牌
- 本地私有队列与 WorkManager 断网重传
- 常驻系统通知、停止动作和唤醒锁

功能页面、文案、状态和后端协议都不得在 Android 中复制。修改普通产品功能只改共享 Web 代码；只有 Android 权限、前台服务或硬件行为变化时才修改 `android/`。

## 为什么网页不能恢复录音

Android Chrome 可以在 HTTPS 页面授权通知并接收 Web Push，但浏览器后台页面可能被冻结或被系统回收。Service Worker 没有麦克风 API，Push 事件也不能静默重新申请麦克风权限。因此网页无法可靠地检测录音被暂停后，在后台自行恢复录音。

APK 使用 Android Foreground Service。用户主动开始陪伴后，系统允许服务在锁屏或页面退到后台时继续录音；相机模式同理，但始终显示 Android 隐私指示器和不可隐藏的常驻通知。系统强制停止应用、撤销权限、重启手机或部分厂商的强力省电策略仍会中止采集，应用不能绕过这些系统决定。

## 环境与构建

需要 Node.js、JDK 21、Android SDK Platform 36 和 platform-tools。SDK 默认位于 `/opt/android-sdk`，也可设置 `ANDROID_SDK_ROOT`。

```bash
npm install
npm run android:doctor
npm run apk:debug
```

Debug APK 输出为 `artifacts/papo-debug.apk`。安装到已开启 USB 调试的手机：

```bash
/opt/android-sdk/platform-tools/adb install -r artifacts/papo-debug.apk
```

发布构建：

```bash
PAPO_ANDROID_VERSION_CODE=3 PAPO_ANDROID_VERSION_NAME=0.2.1 npm run apk:release
```

首次运行会生成 `.papo/android-release.keystore` 和 `.papo/android-signing.properties`，输出 `artifacts/papo-release.apk`。这两个签名文件不会进入 Git，但同一个应用后续升级必须使用同一把密钥，因此正式分发前要安全备份 `.papo/`。丢失密钥后，已安装用户无法原位升级。

APK 默认连接 `https://eu.jerrypsy.top/papo-api`。修改环境地址应通过 `build:android:web` 的 `VITE_API_BASE`，不要在 Java 中另写业务地址。

资料页的“应用更新”会读取 `https://eu.jerrypsy.top/papo/android/latest.json`，比较原生 `versionCode`，并通过系统浏览器下载新版 APK。每次发布必须递增 `PAPO_ANDROID_VERSION_CODE`，更新清单并同时保留版本化 APK；`papo-release.apk` 可作为人工分享用的稳定别名。

## 使用与隐私

1. 登录同一个 Papo 资料。
2. 点击“陪我”，选择“陪我”或“陪我+看我”、相机方向与时长。
3. 首次使用时授权通知、麦克风；看我模式还需授权相机。
4. 退到后台或锁屏后，以 Android 常驻通知确认服务仍在运行，也可从通知直接停止。

音频和可选画面按约 30 秒窗口上传。断网时文件只保存在应用私有目录，联网后重传，成功后删除。服务端保存的是模型生成的观察和对话，不保存周期性原始相机图片。设备令牌有效期 90 天、只以哈希存储在服务端；退出登录或修改密码会吊销设备令牌。

## 通知边界

网页端使用标准 Web Push。APK 的持续陪伴状态使用原生前台服务通知。要让 APK 在 WebView 完全被系统回收后仍接收任意服务端主动消息，需要额外配置 Firebase Cloud Messaging；仓库当前没有项目专属 `google-services.json`，因此未把 FCM 凭据硬编码进通用构建。应用打开或前台服务运行时，上传结果仍会同步到共享会话。

## 验证

```bash
npm test
npm run test:ui
cd android && ./gradlew lintDebug testDebugUnitTest
```

真机验收至少覆盖：锁屏 5 分钟录音、前后摄像头、断网后恢复上传、通知停止、拒绝权限、退出登录后队列停止，以及系统设置中的强制停止。小米、华为、OPPO 等设备还需按实际系统检查“自启动/后台运行/电池不受限制”；应用不应引导用户绕过可见的麦克风或相机隐私提示。
