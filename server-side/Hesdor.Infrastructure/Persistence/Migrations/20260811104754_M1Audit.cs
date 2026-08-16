using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hesdor.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class M1Audit : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "MetadataJson",
                table: "audit_events",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Result",
                table: "audit_events",
                type: "character varying(80)",
                maxLength: 80,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "MetadataJson",
                table: "audit_events");

            migrationBuilder.DropColumn(
                name: "Result",
                table: "audit_events");
        }
    }
}
