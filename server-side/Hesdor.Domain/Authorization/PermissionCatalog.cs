namespace Hesdor.Domain.Authorization;

public sealed record PermissionDefinition(string Code, string Name, string Module, string Description);

public static class PermissionCatalog
{
    public static IReadOnlyCollection<PermissionDefinition> All { get; } =
    [
        new("employees.read", "View employees", "People", "View employee profiles and employment status."),
        new("employees.manage", "Manage employees", "People", "Create, update, and terminate employees."),
        new("roles.manage", "Manage roles", "Authorization", "Manage roles and permission assignments."),
        new("organization.manage", "Manage organization", "Organization", "Manage departments, teams, managers, and locations."),
        new("organization.read", "Read organization", "Organization", "View departments, teams, managers, and locations."),
        new("access.policy.manage", "Manage access policy", "Access", "Manage physical access profiles and rules."),
        new("access.credential.issue", "Issue credentials", "Access", "Issue credentials to employees and visitors."),
        new("access.credential.revoke", "Revoke credentials", "Access", "Revoke physical credentials."),
        new("access.door.unlock_remote", "Remote door unlock", "Access", "Unlock a door remotely after strong authorization."),
        new("access.device.manage", "Manage access devices", "Devices", "Manage controllers, readers, and edge devices."),
        new("attendance.read", "View attendance", "Attendance", "View presence and attendance sessions."),
        new("attendance.edit", "Edit attendance", "Attendance", "Adjust attendance records and schedules."),
        new("projects.manage", "Manage projects", "Work", "Manage projects and project access."),
        new("tasks.manage", "Manage tasks", "Work", "Manage tasks, assignees, and status."),
        new("projects.read", "Read projects", "Work", "View projects and project status."),
        new("tasks.read", "Read tasks", "Work", "View tasks and task activity."),
        new("tasks.create", "Create tasks", "Work", "Create tasks in projects."),
        new("tasks.update", "Update tasks", "Work", "Update task status, priority, and due date."),
        new("tasks.assign", "Assign tasks", "Work", "Add and remove task assignees."),
        new("tasks.comment", "Comment on tasks", "Work", "Create task comments."),
        new("messages.read", "Read messages", "Messaging", "Read organization conversations and channels."),
        new("messages.send", "Send messages", "Messaging", "Send messages in conversations."),
        new("channels.manage", "Manage channels", "Messaging", "Create and manage scoped channels."),
        new("announcements.read", "Read announcements", "Messaging", "Read published announcements."),
        new("announcements.manage", "Manage announcements", "Messaging", "Create and publish announcements."),
        new("files.read", "Read files", "Files", "Read permission-aware company and employee files."),
        new("reports.read", "Read reports", "Reports", "View operational reports."),
        new("audit.read", "Read audit history", "Audit", "Search organization audit history."),
        new("settings.manage", "Manage settings", "Settings", "Manage tenant configuration."),
        new("billing.read", "Read billing", "Billing", "View subscription and entitlement state."),
        new("billing.manage", "Manage billing", "Billing", "Manage manual subscriptions and billing state."),
    ];
}
