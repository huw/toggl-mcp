// The Toggl operations exposed as MCP tools, by generated name, and what each does to your data.
// Everything else in the specs is left out on purpose: account settings (email, password, API token, closing the account),
// organisation, billing and user admin, anything that sends data out of Toggl (webhooks, calendar integrations, scheduled
// or shared reports, invitations, exports), binary report downloads, and deleting anything but a time entry.
// `pnpm generate` fails if a name here is missing from the specs, so a renamed operation can't drop out silently.

export type Kind = "read" | "create" | "update" | "delete";

export const allowlist: Record<string, Kind> = {
	// You and your workspaces
	get_me: "read",
	get_preferences: "read",
	get_workspaces: "read",
	get_workspace: "read",

	// Time entries
	get_time_entries: "read",
	get_current_time_entry: "read",
	get_time_entry_by_id: "read",
	post_workspace_time_entries: "create",
	put_workspace_time_entry_handler: "update",
	patch_time_entries: "update",
	patch_workspace_stop_time_entry_handler: "update",
	delete_workspace_time_entries: "delete",

	// Projects
	get_me_projects: "read",
	get_me_projects_paginated: "read",
	get_projects: "read",
	get_workspaces_projects: "read",
	get_workspaces_projects_statistics: "read",
	post_workspace_project_create: "create",
	put_workspace_project: "update",

	// Clients
	get_clients: "read",
	get_workspace_clients: "read",
	get_workspace_client: "read",
	get_workspace_clients_data: "read",
	post_workspace_clients: "create",
	put_workspace_clients: "update",

	// Tags
	get_tags: "read",
	get_workspace_tag: "read",
	post_workspace_tag: "create",
	put_workspace_tag: "update",

	// Tasks
	get_tasks: "read",
	get_workspace_tasks: "read",
	get_workspace_tasks_basic: "read",
	getworkspacetasksdata: "read",
	get_workspace_project_tasks: "read",
	get_workspace_project_task: "read",
	post_workspace_project_tasks: "create",
	put_workspace_project_task: "update",

	// Reports (POST, but they only read). JSON only: the PDF, CSV and XLSX variants are left out.
	reports_post_search_time_entries: "read",
	reports_post_search_time_entries_totals: "read",
	reports_post_summary_time_entries: "read",
	reports_post_weekly_time_entries: "read",
	reports_post_projects_summary: "read",
	reports_post_projects_summary_2: "read",
	reports_post_search_clients: "read",
	reports_post_search_projects: "read",
	reports_post_search_users: "read",
	reports_post_tasks: "read",
	reports_post_comparative: "read",
	reports_post_profitability_projects_2: "read",
	reports_post_data_trends_clients: "read",
	reports_post_data_trends_projects_2: "read",
	reports_post_data_trends_users: "read",
	reports_post_filters_clients: "read",
	reports_post_filters_project_groups: "read",
	reports_post_filters_project_users: "read",
	reports_post_filters_projects: "read",
	reports_post_filters_projects_status: "read",
	reports_post_filters_tasks_status: "read",
	reports_post_filters_users: "read",
};
