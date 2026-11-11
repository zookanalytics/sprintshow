// The sample's sprint board, as an iOS app. Its UI test, SprintBoardUITests, drives it and
// attaches a screenshot at each step, which `sprintshow simulator` collects in light and dark.
//
// Each task is a button that toggles it done, and the footer counts the tasks and how many
// are done. Nothing is saved, so every launch starts from the same three tasks.

import SwiftUI

@main
struct SprintBoardApp: App {
    var body: some Scene {
        WindowGroup {
            BoardView()
        }
    }
}

struct BoardTask: Identifiable {
    let id: Int
    let title: String
    var done: Bool
}

struct BoardView: View {
    @State private var tasks = [
        BoardTask(id: 0, title: "Ship the demo engine", done: false),
        BoardTask(id: 1, title: "Write the README", done: false),
        BoardTask(id: 2, title: "Cut the first release", done: true),
    ]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach($tasks) { $task in
                        Button {
                            task.done.toggle()
                        } label: {
                            Label(task.title, systemImage: task.done ? "checkmark.circle.fill" : "circle")
                                .strikethrough(task.done)
                                .foregroundStyle(task.done ? .secondary : .primary)
                        }
                        .accessibilityIdentifier("task-\(task.id)")
                    }
                } footer: {
                    Text("\(tasks.count) tasks · \(tasks.filter(\.done).count) done")
                        .accessibilityIdentifier("summary")
                }
            }
            .navigationTitle("Sprint board")
        }
    }
}
