// The sample's sprint board, as an iOS app: the iOS twin of examples/sample-app, which
// demos/ios.md drives on a simulator.
//
// The board starts empty. A task is added by typing its title into the field and tapping
// Add, or pressing Return. Each task is a button that toggles it done, and the summary
// counts the tasks and how many are done. Nothing is saved, so every launch starts empty.
//
// Each control carries an accessibility identifier, which a demo script names it by:
// new-task, add, empty-hint, task (every task), and summary.

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
    @State private var tasks: [BoardTask] = []
    @State private var title = ""

    private var trimmed: String { title.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("Add a task…", text: $title)
                            .accessibilityIdentifier("new-task")
                            .submitLabel(.done)
                            .onSubmit(add)
                        Button("Add", action: add)
                            .accessibilityIdentifier("add")
                            .disabled(trimmed.isEmpty)
                    }
                }
                Section {
                    if tasks.isEmpty {
                        Text("No tasks yet — add one to get started.")
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("empty-hint")
                    }
                    ForEach($tasks) { $task in
                        Button {
                            task.done.toggle()
                        } label: {
                            Label(task.title, systemImage: task.done ? "checkmark.circle.fill" : "circle")
                                .strikethrough(task.done)
                                .foregroundStyle(task.done ? .secondary : .primary)
                        }
                        .accessibilityIdentifier("task")
                        .accessibilityValue(task.done ? "done" : "to do")
                    }
                } footer: {
                    Text("\(tasks.count) tasks · \(tasks.filter(\.done).count) done")
                        .accessibilityIdentifier("summary")
                }
            }
            .navigationTitle("Sprint board")
        }
    }

    private func add() {
        guard !trimmed.isEmpty else { return }
        tasks.append(BoardTask(id: tasks.count, title: trimmed, done: false))
        title = ""
    }
}
