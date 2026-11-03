import SwiftUI

@main
struct CloudSWEApp: App {
    init() {
        #if DEBUG
        FrameWatch.start()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Color.clear
        }
    }
}
