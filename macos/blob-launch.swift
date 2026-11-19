// Blob.app's own program (Contents/MacOS/blob-launch). It starts Blob and stays its parent until Blob ends:
//  - It runs ~/.blob/launch.sh, which runs the app's copy of Node with Blob's start command. Node is this program's
//    child, so macOS charges Node's permissions (Accessibility, Screen Recording, Input Monitoring, the microphone)
//    to Blob.app: one identity, the one the user switched on, however Blob or Node change.
//  - It never changes itself, so Blob.app's signature stays the same across updates (launcher.ts copies it as is).
//  - Opened again while open (Spotlight, Finder, `open`), it tells Blob with SIGUSR2 (mac.ts brings the bubble forward).
//  - Quit, logged out or sent SIGTERM, it passes that on to Blob and ends when Blob has.
//  - It shows nothing: no window, no Dock icon (LSUIElement). What goes wrong goes to ~/.blob/logs/blob-app.log.
// Built by scripts/mac-launcher.sh into assets/mac/blob-launch.
import AppKit
import Darwin

let home = NSHomeDirectory()
let script = home + "/.blob/launch.sh"
let logDir = home + "/.blob/logs"

func log(_ line: String) {
  try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
  guard let h = FileHandle(forWritingAtPath: logDir + "/blob-app.log") ?? {
    FileManager.default.createFile(atPath: logDir + "/blob-app.log", contents: nil)
    return FileHandle(forWritingAtPath: logDir + "/blob-app.log")
  }() else { return }
  h.seekToEndOfFile()
  h.write(Data("Blob.app: \(line)\n".utf8))
  try? h.close()
}

final class Launcher: NSObject, NSApplicationDelegate {
  var child: pid_t = 0
  var sources: [DispatchSourceProtocol] = []
  var quitting = false

  func applicationDidFinishLaunching(_ note: Notification) {
    guard FileManager.default.fileExists(atPath: script) else {
      log("\(script) is missing: start Blob once from its folder (npm start) to write it")
      exit(1)
    }
    var pid: pid_t = 0
    let argv: [UnsafeMutablePointer<CChar>?] = [strdup("/bin/sh"), strdup(script), nil]
    defer { argv.forEach { free($0) } }
    let rc = posix_spawn(&pid, "/bin/sh", nil, nil, argv, environ)
    if rc != 0 {
      log("could not start \(script) (\(String(cString: strerror(rc))))")
      exit(1)
    }
    child = pid

    let exited = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
    exited.setEventHandler { [weak self] in self?.childEnded() }
    exited.resume()
    sources.append(exited)
    var status: Int32 = 0
    if waitpid(pid, &status, WNOHANG) == pid { end(status) }          // it ended before the watch was set

    for sig in [SIGTERM, SIGINT, SIGHUP] {
      signal(sig, SIG_IGN)
      let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      s.setEventHandler { [weak self] in self?.passOn(SIGTERM) }
      s.resume()
      sources.append(s)
    }
  }

  func passOn(_ sig: Int32) { if child > 0 { kill(child, sig) } }

  func childEnded() {
    var status: Int32 = 0
    waitpid(child, &status, 0)
    end(status)
  }

  func end(_ status: Int32) {
    child = 0
    if quitting { NSApp.reply(toApplicationShouldTerminate: true) }
    let code = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 1
    exit(code)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    passOn(SIGUSR2)
    return false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if child <= 0 { return .terminateNow }
    quitting = true
    passOn(SIGTERM)
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {            // Blob did not end in time: end anyway
      if self.child > 0 { kill(self.child, SIGKILL) }
      NSApp.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}

let app = NSApplication.shared
let launcher = Launcher()
app.delegate = launcher
app.setActivationPolicy(.prohibited)
app.run()
