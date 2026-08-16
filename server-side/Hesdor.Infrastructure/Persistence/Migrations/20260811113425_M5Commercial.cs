using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Hesdor.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class M5Commercial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "PlanId",
                table: "tenants",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "billing_customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ExternalReference = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_billing_customers", x => x.Id);
                    table.UniqueConstraint("AK_billing_customers_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_billing_customers_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "billing_events",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ExternalEventId = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    EventType = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    PayloadJson = table.Column<string>(type: "jsonb", nullable: false),
                    Status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ReceivedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ProcessedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    FailureReason = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_billing_events", x => x.Id);
                    table.UniqueConstraint("AK_billing_events_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_billing_events_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "feature_overrides",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Feature = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    IsEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    ValidFromUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ValidToUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_feature_overrides", x => x.Id);
                    table.UniqueConstraint("AK_feature_overrides_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_feature_overrides_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "invoice_references",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ExternalReference = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    Status = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    IssuedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DueAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_invoice_references", x => x.Id);
                    table.UniqueConstraint("AK_invoice_references_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_invoice_references_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "payment_provider_references",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ReferenceType = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    ExternalReference = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_payment_provider_references", x => x.Id);
                    table.UniqueConstraint("AK_payment_provider_references_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_payment_provider_references_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "plans",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Code = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Name = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    MonthlyPrice = table.Column<decimal>(type: "numeric(18,2)", precision: 18, scale: 2, nullable: false),
                    AnnualPrice = table.Column<decimal>(type: "numeric(18,2)", precision: 18, scale: 2, nullable: false),
                    CurrencyCode = table.Column<string>(type: "character varying(3)", maxLength: 3, nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plans", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "tenant_entitlements",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Feature = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    IsEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    Source = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    ValidFromUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ValidToUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_tenant_entitlements", x => x.Id);
                    table.UniqueConstraint("AK_tenant_entitlements_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_tenant_entitlements_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "tenant_limit_overrides",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Limit = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Value = table.Column<long>(type: "bigint", nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    ValidFromUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ValidToUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_tenant_limit_overrides", x => x.Id);
                    table.UniqueConstraint("AK_tenant_limit_overrides_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_tenant_limit_overrides_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "tenant_trials",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    StartedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    EndsAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ConvertedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_tenant_trials", x => x.Id);
                    table.UniqueConstraint("AK_tenant_trials_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_tenant_trials_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "plan_features",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    PlanId = table.Column<Guid>(type: "uuid", nullable: false),
                    Feature = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    IsEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plan_features", x => x.Id);
                    table.ForeignKey(
                        name: "FK_plan_features_plans_PlanId",
                        column: x => x.PlanId,
                        principalTable: "plans",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "plan_limits",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    PlanId = table.Column<Guid>(type: "uuid", nullable: false),
                    Limit = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Value = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plan_limits", x => x.Id);
                    table.ForeignKey(
                        name: "FK_plan_limits_plans_PlanId",
                        column: x => x.PlanId,
                        principalTable: "plans",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "subscriptions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    PlanId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    BillingCycle = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    StartedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CurrentPeriodStartUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CurrentPeriodEndUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    TrialEndsAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    GracePeriodEndsAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CancelAtPeriodEnd = table.Column<bool>(type: "boolean", nullable: false),
                    CanceledAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CancellationReason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_subscriptions", x => x.Id);
                    table.UniqueConstraint("AK_subscriptions_TenantId_Id", x => new { x.TenantId, x.Id });
                    table.ForeignKey(
                        name: "FK_subscriptions_plans_PlanId",
                        column: x => x.PlanId,
                        principalTable: "plans",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_subscriptions_tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.InsertData(
                table: "plans",
                columns: new[] { "Id", "AnnualPrice", "Code", "CreatedAtUtc", "CurrencyCode", "IsActive", "MonthlyPrice", "Name", "UpdatedAtUtc" },
                values: new object[,]
                {
                    { new Guid("10000000-0000-0000-0000-000000000001"), 0m, "free", new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "USD", true, 0m, "Free", new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("10000000-0000-0000-0000-000000000002"), 490m, "starter", new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "USD", true, 49m, "Starter", new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("10000000-0000-0000-0000-000000000003"), 1990m, "business", new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "USD", true, 199m, "Business", new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("10000000-0000-0000-0000-000000000004"), 0m, "enterprise", new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "USD", true, 0m, "Enterprise", new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) }
                });

            migrationBuilder.InsertData(
                table: "plan_features",
                columns: new[] { "Id", "CreatedAtUtc", "Feature", "IsEnabled", "PlanId", "UpdatedAtUtc" },
                values: new object[,]
                {
                    { new Guid("02c9f37c-69fd-55fa-d171-db7ff5df7c26"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Messaging", true, new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("0c07d131-c79a-43f9-58d5-17de5a98f375"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AccessControl", true, new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("174f6b5e-8f90-ad0a-1cea-f29e4d66fe38"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Work", true, new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("21ab458d-7127-c0d4-61a9-1da9c56dcc0b"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "VisitorManagement", true, new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("229cf0be-9416-9160-7358-a0b53c7d63e1"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Audit", true, new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("27b804bc-7d3e-acb3-ea16-61ff27fae578"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AdvancedReports", false, new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("288f2936-0306-3d83-9180-4deaf8379820"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Attendance", true, new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("2ccd2295-83fa-3be4-3349-af8668f4bab7"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "VisitorManagement", false, new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("3dfaf71e-f00d-a09a-10f5-9409779fe577"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AccessControl", true, new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("409ea6f5-ea6e-667e-0c3e-c49a0027fa59"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Audit", true, new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("4f2ac9f9-188a-b520-67ca-174045476fdb"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Messaging", true, new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("52ae0dce-8a4c-41df-7c68-52b51ea3c3b4"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Attendance", true, new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("54540a70-6c4a-f081-43bc-d1ae3d5d52c2"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Work", true, new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("54f66c43-130e-9f8c-f3ac-817f415310c5"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Messaging", false, new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("57ef7b30-5f30-9597-cefa-ef668a3af247"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Audit", true, new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("631c3bf2-b815-226f-c2e9-061ced8d4211"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "VisitorManagement", true, new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("73463d61-026d-a18d-5410-316e024cb463"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Work", true, new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("7dcb3361-ad74-9332-9cb9-b63100e97e13"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Work", true, new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("88610dfd-81cb-5507-c476-e840844fb771"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Files", false, new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("8dbc445e-9f66-2385-78b3-d1baa40171b2"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Attendance", true, new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("8fcbcdc7-6527-5afc-bdaf-94dd7b62ce6b"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AdvancedReports", false, new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("986a77f0-a645-4335-e2e3-45bf4e1f2288"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "VisitorManagement", false, new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("a7ed542a-d6ec-d3ff-5a1b-c6e41ebc4478"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AdvancedReports", true, new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("afdad447-a8f9-aeac-2e47-aada078856ba"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Files", true, new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("b65b7c0b-52a7-2f11-a98e-f67a8d0d7e39"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AccessControl", true, new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("c6e8e7bd-252c-98a9-9f61-e933b185429c"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AccessControl", true, new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("dacdcfc3-37ff-7889-facd-a749bedb826c"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Audit", true, new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("e44aedd8-903e-9370-4539-7dbd5e9afbd6"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Attendance", true, new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("e8f9723b-429b-97cb-5a05-c7de3ee5f316"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Files", true, new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("ed7d6680-43f5-b69b-477c-f9c2a8232875"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Files", true, new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("f1dc2dae-2aca-ee71-acb5-31a0ad7e817f"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AdvancedReports", true, new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) },
                    { new Guid("f34b4895-1151-825c-6029-4c22b4119b00"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "Messaging", true, new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc) }
                });

            migrationBuilder.InsertData(
                table: "plan_limits",
                columns: new[] { "Id", "CreatedAtUtc", "Limit", "PlanId", "UpdatedAtUtc", "Value" },
                values: new object[,]
                {
                    { new Guid("020761b6-6ed4-8974-c8ae-ba84c4e6955c"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AuditRetentionDays", new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 365L },
                    { new Guid("0605418a-5292-88c1-8da2-56d51e0da9b4"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxEmployees", new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 250L },
                    { new Guid("0b90cd3f-aeb9-05e9-9c59-c9b5382b5b1c"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxEmployees", new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 25L },
                    { new Guid("0f928377-6e8f-6219-cc57-33efd86d6147"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AuditRetentionDays", new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 30L },
                    { new Guid("1786907a-bddb-a532-5c40-95b04ad7aadd"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxDoors", new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), -1L },
                    { new Guid("1c292422-9272-e74a-8e68-fd5d28c243d1"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxEmployees", new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 5L },
                    { new Guid("1d878f82-20d9-91eb-890c-10418fc7e383"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxLocations", new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 1L },
                    { new Guid("41c2c412-c743-e4fc-a92c-59676436b6a0"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "StorageBytes", new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 104857600L },
                    { new Guid("4c01bcc7-a832-26bc-d557-5a4492bc7f97"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxLocations", new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 5L },
                    { new Guid("4e190b14-554b-eced-a051-7ffcc3f7462f"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxEmployees", new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), -1L },
                    { new Guid("544016e5-2f70-6e4b-ec63-a51e4896bc2c"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AuditRetentionDays", new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 90L },
                    { new Guid("54a445e1-a5b1-a599-1244-e6392af956d0"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "StorageBytes", new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 53687091200L },
                    { new Guid("5875541c-7cc9-bd9f-c6be-1cd3980d9480"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxLocations", new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 1L },
                    { new Guid("6fcb2f49-e303-f80e-2321-c699d66d824f"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "StorageBytes", new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), -1L },
                    { new Guid("84ecf0b1-10f7-999c-a256-7369af4e1db6"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxDoors", new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 100L },
                    { new Guid("865dd0ac-0bf2-ea51-3354-f83791550e52"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxDoors", new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 10L },
                    { new Guid("89c91801-84da-5269-2663-44f9a5f7f614"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxActiveCredentials", new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), -1L },
                    { new Guid("96211554-add8-f554-7240-9ac975d31ec2"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxLocations", new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), -1L },
                    { new Guid("99efa1d6-0a57-531b-03b8-7722aaa9c470"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxActiveCredentials", new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 50L },
                    { new Guid("b0d98a4c-05ec-9d26-386a-32fd4d920261"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxDoors", new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 2L },
                    { new Guid("c5f581bc-acfe-aa79-c9e4-dacc93329dd9"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "AuditRetentionDays", new Guid("10000000-0000-0000-0000-000000000004"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 3650L },
                    { new Guid("d0113d7c-5b8b-0925-421b-ad81876b48aa"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "StorageBytes", new Guid("10000000-0000-0000-0000-000000000002"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 5368709120L },
                    { new Guid("f1932036-4603-5e97-134e-99731e747c04"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxActiveCredentials", new Guid("10000000-0000-0000-0000-000000000003"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 500L },
                    { new Guid("fb0108e9-1482-f33f-748f-777577a6d64c"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), "MaxActiveCredentials", new Guid("10000000-0000-0000-0000-000000000001"), new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc), 5L }
                });

            migrationBuilder.CreateIndex(
                name: "IX_tenants_PlanId",
                table: "tenants",
                column: "PlanId");

            migrationBuilder.CreateIndex(
                name: "IX_billing_customers_TenantId_Provider",
                table: "billing_customers",
                columns: new[] { "TenantId", "Provider" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_billing_events_TenantId_Provider_ExternalEventId",
                table: "billing_events",
                columns: new[] { "TenantId", "Provider", "ExternalEventId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_billing_events_TenantId_ReceivedAtUtc",
                table: "billing_events",
                columns: new[] { "TenantId", "ReceivedAtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_feature_overrides_TenantId_Feature_ValidFromUtc_ValidToUtc",
                table: "feature_overrides",
                columns: new[] { "TenantId", "Feature", "ValidFromUtc", "ValidToUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_invoice_references_TenantId_Provider_ExternalReference",
                table: "invoice_references",
                columns: new[] { "TenantId", "Provider", "ExternalReference" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_payment_provider_references_TenantId_Provider_ReferenceType~",
                table: "payment_provider_references",
                columns: new[] { "TenantId", "Provider", "ReferenceType", "ExternalReference" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_plan_features_PlanId_Feature",
                table: "plan_features",
                columns: new[] { "PlanId", "Feature" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_plan_limits_PlanId_Limit",
                table: "plan_limits",
                columns: new[] { "PlanId", "Limit" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_plans_Code",
                table: "plans",
                column: "Code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_subscriptions_PlanId",
                table: "subscriptions",
                column: "PlanId");

            migrationBuilder.CreateIndex(
                name: "IX_subscriptions_TenantId_CurrentPeriodEndUtc",
                table: "subscriptions",
                columns: new[] { "TenantId", "CurrentPeriodEndUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_subscriptions_TenantId_Status_CurrentPeriodEndUtc",
                table: "subscriptions",
                columns: new[] { "TenantId", "Status", "CurrentPeriodEndUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_tenant_entitlements_TenantId_Feature_ValidFromUtc_ValidToUtc",
                table: "tenant_entitlements",
                columns: new[] { "TenantId", "Feature", "ValidFromUtc", "ValidToUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_tenant_limit_overrides_TenantId_Limit_ValidFromUtc_ValidToU~",
                table: "tenant_limit_overrides",
                columns: new[] { "TenantId", "Limit", "ValidFromUtc", "ValidToUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_tenant_trials_TenantId_EndsAtUtc",
                table: "tenant_trials",
                columns: new[] { "TenantId", "EndsAtUtc" });

            migrationBuilder.AddForeignKey(
                name: "FK_tenants_plans_PlanId",
                table: "tenants",
                column: "PlanId",
                principalTable: "plans",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_tenants_plans_PlanId",
                table: "tenants");

            migrationBuilder.DropTable(
                name: "billing_customers");

            migrationBuilder.DropTable(
                name: "billing_events");

            migrationBuilder.DropTable(
                name: "feature_overrides");

            migrationBuilder.DropTable(
                name: "invoice_references");

            migrationBuilder.DropTable(
                name: "payment_provider_references");

            migrationBuilder.DropTable(
                name: "plan_features");

            migrationBuilder.DropTable(
                name: "plan_limits");

            migrationBuilder.DropTable(
                name: "subscriptions");

            migrationBuilder.DropTable(
                name: "tenant_entitlements");

            migrationBuilder.DropTable(
                name: "tenant_limit_overrides");

            migrationBuilder.DropTable(
                name: "tenant_trials");

            migrationBuilder.DropTable(
                name: "plans");

            migrationBuilder.DropIndex(
                name: "IX_tenants_PlanId",
                table: "tenants");

            migrationBuilder.DropColumn(
                name: "PlanId",
                table: "tenants");
        }
    }
}
