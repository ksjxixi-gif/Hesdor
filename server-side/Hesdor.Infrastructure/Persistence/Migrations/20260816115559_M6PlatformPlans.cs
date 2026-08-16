using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hesdor.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class M6PlatformPlans : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "IsPlatform",
                table: "tenants",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            // Backfill for existing installs: the oldest tenant is the Hesdor platform team.
            migrationBuilder.Sql("""
                UPDATE "tenants" SET "IsPlatform" = true
                WHERE "Id" = (SELECT "Id" FROM "tenants" ORDER BY "CreatedAtUtc" LIMIT 1);

                INSERT INTO "permissions" ("Id", "Code", "Name", "Module", "Description", "CreatedAtUtc", "UpdatedAtUtc")
                SELECT gen_random_uuid(), 'platform.plans.manage', 'Manage platform plans', 'Platform',
                       'Define plans, features, and limits. Restricted to the Hesdor platform team.', now(), now()
                WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "Code" = 'platform.plans.manage');

                INSERT INTO "role_permissions" ("Id", "TenantId", "RoleId", "PermissionId", "IsAllowed", "IsDeleted", "CreatedAtUtc", "UpdatedAtUtc")
                SELECT gen_random_uuid(), rp."TenantId", rp."RoleId", p."Id", true, false, now(), now()
                FROM "role_permissions" rp
                JOIN "permissions" p ON p."Code" = 'platform.plans.manage'
                JOIN "permissions" bp ON bp."Code" = 'billing.manage'
                JOIN "role_permissions" bpr ON bpr."RoleId" = rp."RoleId" AND bpr."PermissionId" = bp."Id"
                JOIN "tenants" t ON t."Id" = rp."TenantId" AND t."IsPlatform" = true
                WHERE NOT EXISTS (
                    SELECT 1 FROM "role_permissions" existing
                    WHERE existing."RoleId" = rp."RoleId" AND existing."PermissionId" = p."Id");
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "IsPlatform",
                table: "tenants");
        }
    }
}
