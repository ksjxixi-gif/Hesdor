using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hesdor.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class M1TenantIntegrity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_audit_events_TenantId_EntityType_EntityId",
                table: "audit_events");

            migrationBuilder.DropIndex(
                name: "IX_audit_events_TenantId_OccurredAtUtc",
                table: "audit_events");

            migrationBuilder.DropIndex(
                name: "IX_access_events_TenantId_OccurredAtUtc",
                table: "access_events");

            migrationBuilder.AddUniqueConstraint(
                name: "AK_zones_TenantId_Id",
                table: "zones",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_users_TenantId_Id",
                table: "users",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_temporary_access_grants_TenantId_Id",
                table: "temporary_access_grants",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_teams_TenantId_Id",
                table: "teams",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_roles_TenantId_Id",
                table: "roles",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_role_permissions_TenantId_Id",
                table: "role_permissions",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_refresh_tokens_TenantId_Id",
                table: "refresh_tokens",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_readers_TenantId_Id",
                table: "readers",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_locations_TenantId_Id",
                table: "locations",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_floors_TenantId_Id",
                table: "floors",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_employees_TenantId_Id",
                table: "employees",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_employee_roles_TenantId_Id",
                table: "employee_roles",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_employee_permissions_TenantId_Id",
                table: "employee_permissions",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_employee_access_profiles_TenantId_Id",
                table: "employee_access_profiles",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_edge_agents_TenantId_Id",
                table: "edge_agents",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_doors_TenantId_Id",
                table: "doors",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_departments_TenantId_Id",
                table: "departments",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_credentials_TenantId_Id",
                table: "credentials",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_buildings_TenantId_Id",
                table: "buildings",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_audit_events_TenantId_Id",
                table: "audit_events",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_access_rules_TenantId_Id",
                table: "access_rules",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_access_profiles_TenantId_Id",
                table: "access_profiles",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_access_events_TenantId_Id",
                table: "access_events",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.AddUniqueConstraint(
                name: "AK_access_controllers_TenantId_Id",
                table: "access_controllers",
                columns: new[] { "TenantId", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_role_permissions_PermissionId",
                table: "role_permissions",
                column: "PermissionId");

            migrationBuilder.CreateIndex(
                name: "IX_readers_TenantId_AccessControllerId",
                table: "readers",
                columns: new[] { "TenantId", "AccessControllerId" });

            migrationBuilder.CreateIndex(
                name: "IX_readers_TenantId_DoorId",
                table: "readers",
                columns: new[] { "TenantId", "DoorId" });

            migrationBuilder.CreateIndex(
                name: "IX_employees_TenantId_DepartmentId",
                table: "employees",
                columns: new[] { "TenantId", "DepartmentId" });

            migrationBuilder.CreateIndex(
                name: "IX_employees_TenantId_EmploymentStatus",
                table: "employees",
                columns: new[] { "TenantId", "EmploymentStatus" });

            migrationBuilder.CreateIndex(
                name: "IX_employees_TenantId_ManagerId",
                table: "employees",
                columns: new[] { "TenantId", "ManagerId" });

            migrationBuilder.CreateIndex(
                name: "IX_employee_roles_TenantId_RoleId",
                table: "employee_roles",
                columns: new[] { "TenantId", "RoleId" });

            migrationBuilder.CreateIndex(
                name: "IX_employee_permissions_PermissionId",
                table: "employee_permissions",
                column: "PermissionId");

            migrationBuilder.CreateIndex(
                name: "IX_employee_access_profiles_TenantId_AccessProfileId",
                table: "employee_access_profiles",
                columns: new[] { "TenantId", "AccessProfileId" });

            migrationBuilder.CreateIndex(
                name: "IX_edge_agents_TenantId_LocationId",
                table: "edge_agents",
                columns: new[] { "TenantId", "LocationId" });

            migrationBuilder.CreateIndex(
                name: "IX_departments_TenantId_ParentDepartmentId",
                table: "departments",
                columns: new[] { "TenantId", "ParentDepartmentId" });

            migrationBuilder.CreateIndex(
                name: "IX_audit_events_TenantId_ActorUserId_OccurredAtUtc",
                table: "audit_events",
                columns: new[] { "TenantId", "ActorUserId", "OccurredAtUtc" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "IX_audit_events_TenantId_EntityType_EntityId_OccurredAtUtc",
                table: "audit_events",
                columns: new[] { "TenantId", "EntityType", "EntityId", "OccurredAtUtc" },
                descending: new[] { false, false, false, true });

            migrationBuilder.CreateIndex(
                name: "IX_audit_events_TenantId_OccurredAtUtc",
                table: "audit_events",
                columns: new[] { "TenantId", "OccurredAtUtc" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "IX_access_rules_TenantId_DoorId_ValidFromUtc_ValidToUtc",
                table: "access_rules",
                columns: new[] { "TenantId", "DoorId", "ValidFromUtc", "ValidToUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_access_rules_TenantId_ZoneId_ValidFromUtc_ValidToUtc",
                table: "access_rules",
                columns: new[] { "TenantId", "ZoneId", "ValidFromUtc", "ValidToUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_access_events_TenantId_Decision_OccurredAtUtc",
                table: "access_events",
                columns: new[] { "TenantId", "Decision", "OccurredAtUtc" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "IX_access_events_TenantId_DoorId_OccurredAtUtc",
                table: "access_events",
                columns: new[] { "TenantId", "DoorId", "OccurredAtUtc" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "IX_access_events_TenantId_EmployeeId_OccurredAtUtc",
                table: "access_events",
                columns: new[] { "TenantId", "EmployeeId", "OccurredAtUtc" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "IX_access_events_TenantId_OccurredAtUtc",
                table: "access_events",
                columns: new[] { "TenantId", "OccurredAtUtc" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "IX_access_controllers_TenantId_LocationId",
                table: "access_controllers",
                columns: new[] { "TenantId", "LocationId" });

            migrationBuilder.CreateIndex(
                name: "IX_access_controllers_TenantId_Status_LastHeartbeatAtUtc",
                table: "access_controllers",
                columns: new[] { "TenantId", "Status", "LastHeartbeatAtUtc" });

            migrationBuilder.AddForeignKey(
                name: "FK_access_controllers_locations_TenantId_LocationId",
                table: "access_controllers",
                columns: new[] { "TenantId", "LocationId" },
                principalTable: "locations",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_access_controllers_tenants_TenantId",
                table: "access_controllers",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_access_events_doors_TenantId_DoorId",
                table: "access_events",
                columns: new[] { "TenantId", "DoorId" },
                principalTable: "doors",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_access_events_tenants_TenantId",
                table: "access_events",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_access_profiles_tenants_TenantId",
                table: "access_profiles",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_access_rules_access_profiles_TenantId_AccessProfileId",
                table: "access_rules",
                columns: new[] { "TenantId", "AccessProfileId" },
                principalTable: "access_profiles",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_access_rules_tenants_TenantId",
                table: "access_rules",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_audit_events_tenants_TenantId",
                table: "audit_events",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_buildings_locations_TenantId_LocationId",
                table: "buildings",
                columns: new[] { "TenantId", "LocationId" },
                principalTable: "locations",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_buildings_tenants_TenantId",
                table: "buildings",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_credentials_tenants_TenantId",
                table: "credentials",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_departments_tenants_TenantId",
                table: "departments",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_doors_tenants_TenantId",
                table: "doors",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_doors_zones_TenantId_ZoneId",
                table: "doors",
                columns: new[] { "TenantId", "ZoneId" },
                principalTable: "zones",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_edge_agents_locations_TenantId_LocationId",
                table: "edge_agents",
                columns: new[] { "TenantId", "LocationId" },
                principalTable: "locations",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_edge_agents_tenants_TenantId",
                table: "edge_agents",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_access_profiles_access_profiles_TenantId_AccessPro~",
                table: "employee_access_profiles",
                columns: new[] { "TenantId", "AccessProfileId" },
                principalTable: "access_profiles",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_access_profiles_employees_TenantId_EmployeeId",
                table: "employee_access_profiles",
                columns: new[] { "TenantId", "EmployeeId" },
                principalTable: "employees",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_access_profiles_tenants_TenantId",
                table: "employee_access_profiles",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_permissions_employees_TenantId_EmployeeId",
                table: "employee_permissions",
                columns: new[] { "TenantId", "EmployeeId" },
                principalTable: "employees",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_permissions_permissions_PermissionId",
                table: "employee_permissions",
                column: "PermissionId",
                principalTable: "permissions",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_permissions_tenants_TenantId",
                table: "employee_permissions",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_roles_employees_TenantId_EmployeeId",
                table: "employee_roles",
                columns: new[] { "TenantId", "EmployeeId" },
                principalTable: "employees",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_roles_roles_TenantId_RoleId",
                table: "employee_roles",
                columns: new[] { "TenantId", "RoleId" },
                principalTable: "roles",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employee_roles_tenants_TenantId",
                table: "employee_roles",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_employees_tenants_TenantId",
                table: "employees",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_floors_buildings_TenantId_BuildingId",
                table: "floors",
                columns: new[] { "TenantId", "BuildingId" },
                principalTable: "buildings",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_floors_tenants_TenantId",
                table: "floors",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_locations_tenants_TenantId",
                table: "locations",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_readers_access_controllers_TenantId_AccessControllerId",
                table: "readers",
                columns: new[] { "TenantId", "AccessControllerId" },
                principalTable: "access_controllers",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_readers_doors_TenantId_DoorId",
                table: "readers",
                columns: new[] { "TenantId", "DoorId" },
                principalTable: "doors",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_readers_tenants_TenantId",
                table: "readers",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_refresh_tokens_tenants_TenantId",
                table: "refresh_tokens",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_refresh_tokens_users_TenantId_UserId",
                table: "refresh_tokens",
                columns: new[] { "TenantId", "UserId" },
                principalTable: "users",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_role_permissions_permissions_PermissionId",
                table: "role_permissions",
                column: "PermissionId",
                principalTable: "permissions",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_role_permissions_roles_TenantId_RoleId",
                table: "role_permissions",
                columns: new[] { "TenantId", "RoleId" },
                principalTable: "roles",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_role_permissions_tenants_TenantId",
                table: "role_permissions",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_roles_tenants_TenantId",
                table: "roles",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_teams_tenants_TenantId",
                table: "teams",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_temporary_access_grants_employees_TenantId_EmployeeId",
                table: "temporary_access_grants",
                columns: new[] { "TenantId", "EmployeeId" },
                principalTable: "employees",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_temporary_access_grants_tenants_TenantId",
                table: "temporary_access_grants",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_users_tenants_TenantId",
                table: "users",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_zones_floors_TenantId_FloorId",
                table: "zones",
                columns: new[] { "TenantId", "FloorId" },
                principalTable: "floors",
                principalColumns: new[] { "TenantId", "Id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_zones_tenants_TenantId",
                table: "zones",
                column: "TenantId",
                principalTable: "tenants",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_access_controllers_locations_TenantId_LocationId",
                table: "access_controllers");

            migrationBuilder.DropForeignKey(
                name: "FK_access_controllers_tenants_TenantId",
                table: "access_controllers");

            migrationBuilder.DropForeignKey(
                name: "FK_access_events_doors_TenantId_DoorId",
                table: "access_events");

            migrationBuilder.DropForeignKey(
                name: "FK_access_events_tenants_TenantId",
                table: "access_events");

            migrationBuilder.DropForeignKey(
                name: "FK_access_profiles_tenants_TenantId",
                table: "access_profiles");

            migrationBuilder.DropForeignKey(
                name: "FK_access_rules_access_profiles_TenantId_AccessProfileId",
                table: "access_rules");

            migrationBuilder.DropForeignKey(
                name: "FK_access_rules_tenants_TenantId",
                table: "access_rules");

            migrationBuilder.DropForeignKey(
                name: "FK_audit_events_tenants_TenantId",
                table: "audit_events");

            migrationBuilder.DropForeignKey(
                name: "FK_buildings_locations_TenantId_LocationId",
                table: "buildings");

            migrationBuilder.DropForeignKey(
                name: "FK_buildings_tenants_TenantId",
                table: "buildings");

            migrationBuilder.DropForeignKey(
                name: "FK_credentials_tenants_TenantId",
                table: "credentials");

            migrationBuilder.DropForeignKey(
                name: "FK_departments_tenants_TenantId",
                table: "departments");

            migrationBuilder.DropForeignKey(
                name: "FK_doors_tenants_TenantId",
                table: "doors");

            migrationBuilder.DropForeignKey(
                name: "FK_doors_zones_TenantId_ZoneId",
                table: "doors");

            migrationBuilder.DropForeignKey(
                name: "FK_edge_agents_locations_TenantId_LocationId",
                table: "edge_agents");

            migrationBuilder.DropForeignKey(
                name: "FK_edge_agents_tenants_TenantId",
                table: "edge_agents");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_access_profiles_access_profiles_TenantId_AccessPro~",
                table: "employee_access_profiles");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_access_profiles_employees_TenantId_EmployeeId",
                table: "employee_access_profiles");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_access_profiles_tenants_TenantId",
                table: "employee_access_profiles");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_permissions_employees_TenantId_EmployeeId",
                table: "employee_permissions");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_permissions_permissions_PermissionId",
                table: "employee_permissions");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_permissions_tenants_TenantId",
                table: "employee_permissions");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_roles_employees_TenantId_EmployeeId",
                table: "employee_roles");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_roles_roles_TenantId_RoleId",
                table: "employee_roles");

            migrationBuilder.DropForeignKey(
                name: "FK_employee_roles_tenants_TenantId",
                table: "employee_roles");

            migrationBuilder.DropForeignKey(
                name: "FK_employees_tenants_TenantId",
                table: "employees");

            migrationBuilder.DropForeignKey(
                name: "FK_floors_buildings_TenantId_BuildingId",
                table: "floors");

            migrationBuilder.DropForeignKey(
                name: "FK_floors_tenants_TenantId",
                table: "floors");

            migrationBuilder.DropForeignKey(
                name: "FK_locations_tenants_TenantId",
                table: "locations");

            migrationBuilder.DropForeignKey(
                name: "FK_readers_access_controllers_TenantId_AccessControllerId",
                table: "readers");

            migrationBuilder.DropForeignKey(
                name: "FK_readers_doors_TenantId_DoorId",
                table: "readers");

            migrationBuilder.DropForeignKey(
                name: "FK_readers_tenants_TenantId",
                table: "readers");

            migrationBuilder.DropForeignKey(
                name: "FK_refresh_tokens_tenants_TenantId",
                table: "refresh_tokens");

            migrationBuilder.DropForeignKey(
                name: "FK_refresh_tokens_users_TenantId_UserId",
                table: "refresh_tokens");

            migrationBuilder.DropForeignKey(
                name: "FK_role_permissions_permissions_PermissionId",
                table: "role_permissions");

            migrationBuilder.DropForeignKey(
                name: "FK_role_permissions_roles_TenantId_RoleId",
                table: "role_permissions");

            migrationBuilder.DropForeignKey(
                name: "FK_role_permissions_tenants_TenantId",
                table: "role_permissions");

            migrationBuilder.DropForeignKey(
                name: "FK_roles_tenants_TenantId",
                table: "roles");

            migrationBuilder.DropForeignKey(
                name: "FK_teams_tenants_TenantId",
                table: "teams");

            migrationBuilder.DropForeignKey(
                name: "FK_temporary_access_grants_employees_TenantId_EmployeeId",
                table: "temporary_access_grants");

            migrationBuilder.DropForeignKey(
                name: "FK_temporary_access_grants_tenants_TenantId",
                table: "temporary_access_grants");

            migrationBuilder.DropForeignKey(
                name: "FK_users_tenants_TenantId",
                table: "users");

            migrationBuilder.DropForeignKey(
                name: "FK_zones_floors_TenantId_FloorId",
                table: "zones");

            migrationBuilder.DropForeignKey(
                name: "FK_zones_tenants_TenantId",
                table: "zones");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_zones_TenantId_Id",
                table: "zones");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_users_TenantId_Id",
                table: "users");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_temporary_access_grants_TenantId_Id",
                table: "temporary_access_grants");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_teams_TenantId_Id",
                table: "teams");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_roles_TenantId_Id",
                table: "roles");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_role_permissions_TenantId_Id",
                table: "role_permissions");

            migrationBuilder.DropIndex(
                name: "IX_role_permissions_PermissionId",
                table: "role_permissions");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_refresh_tokens_TenantId_Id",
                table: "refresh_tokens");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_readers_TenantId_Id",
                table: "readers");

            migrationBuilder.DropIndex(
                name: "IX_readers_TenantId_AccessControllerId",
                table: "readers");

            migrationBuilder.DropIndex(
                name: "IX_readers_TenantId_DoorId",
                table: "readers");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_locations_TenantId_Id",
                table: "locations");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_floors_TenantId_Id",
                table: "floors");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_employees_TenantId_Id",
                table: "employees");

            migrationBuilder.DropIndex(
                name: "IX_employees_TenantId_DepartmentId",
                table: "employees");

            migrationBuilder.DropIndex(
                name: "IX_employees_TenantId_EmploymentStatus",
                table: "employees");

            migrationBuilder.DropIndex(
                name: "IX_employees_TenantId_ManagerId",
                table: "employees");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_employee_roles_TenantId_Id",
                table: "employee_roles");

            migrationBuilder.DropIndex(
                name: "IX_employee_roles_TenantId_RoleId",
                table: "employee_roles");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_employee_permissions_TenantId_Id",
                table: "employee_permissions");

            migrationBuilder.DropIndex(
                name: "IX_employee_permissions_PermissionId",
                table: "employee_permissions");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_employee_access_profiles_TenantId_Id",
                table: "employee_access_profiles");

            migrationBuilder.DropIndex(
                name: "IX_employee_access_profiles_TenantId_AccessProfileId",
                table: "employee_access_profiles");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_edge_agents_TenantId_Id",
                table: "edge_agents");

            migrationBuilder.DropIndex(
                name: "IX_edge_agents_TenantId_LocationId",
                table: "edge_agents");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_doors_TenantId_Id",
                table: "doors");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_departments_TenantId_Id",
                table: "departments");

            migrationBuilder.DropIndex(
                name: "IX_departments_TenantId_ParentDepartmentId",
                table: "departments");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_credentials_TenantId_Id",
                table: "credentials");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_buildings_TenantId_Id",
                table: "buildings");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_audit_events_TenantId_Id",
                table: "audit_events");

            migrationBuilder.DropIndex(
                name: "IX_audit_events_TenantId_ActorUserId_OccurredAtUtc",
                table: "audit_events");

            migrationBuilder.DropIndex(
                name: "IX_audit_events_TenantId_EntityType_EntityId_OccurredAtUtc",
                table: "audit_events");

            migrationBuilder.DropIndex(
                name: "IX_audit_events_TenantId_OccurredAtUtc",
                table: "audit_events");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_access_rules_TenantId_Id",
                table: "access_rules");

            migrationBuilder.DropIndex(
                name: "IX_access_rules_TenantId_DoorId_ValidFromUtc_ValidToUtc",
                table: "access_rules");

            migrationBuilder.DropIndex(
                name: "IX_access_rules_TenantId_ZoneId_ValidFromUtc_ValidToUtc",
                table: "access_rules");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_access_profiles_TenantId_Id",
                table: "access_profiles");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_access_events_TenantId_Id",
                table: "access_events");

            migrationBuilder.DropIndex(
                name: "IX_access_events_TenantId_Decision_OccurredAtUtc",
                table: "access_events");

            migrationBuilder.DropIndex(
                name: "IX_access_events_TenantId_DoorId_OccurredAtUtc",
                table: "access_events");

            migrationBuilder.DropIndex(
                name: "IX_access_events_TenantId_EmployeeId_OccurredAtUtc",
                table: "access_events");

            migrationBuilder.DropIndex(
                name: "IX_access_events_TenantId_OccurredAtUtc",
                table: "access_events");

            migrationBuilder.DropUniqueConstraint(
                name: "AK_access_controllers_TenantId_Id",
                table: "access_controllers");

            migrationBuilder.DropIndex(
                name: "IX_access_controllers_TenantId_LocationId",
                table: "access_controllers");

            migrationBuilder.DropIndex(
                name: "IX_access_controllers_TenantId_Status_LastHeartbeatAtUtc",
                table: "access_controllers");

            migrationBuilder.CreateIndex(
                name: "IX_audit_events_TenantId_EntityType_EntityId",
                table: "audit_events",
                columns: new[] { "TenantId", "EntityType", "EntityId" });

            migrationBuilder.CreateIndex(
                name: "IX_audit_events_TenantId_OccurredAtUtc",
                table: "audit_events",
                columns: new[] { "TenantId", "OccurredAtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_access_events_TenantId_OccurredAtUtc",
                table: "access_events",
                columns: new[] { "TenantId", "OccurredAtUtc" });
        }
    }
}
