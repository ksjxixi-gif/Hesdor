FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["server-side/Hesdor.Api/Hesdor.Api.csproj", "server-side/Hesdor.Api/"]
COPY ["server-side/Hesdor.Application/Hesdor.Application.csproj", "server-side/Hesdor.Application/"]
COPY ["server-side/Hesdor.Domain/Hesdor.Domain.csproj", "server-side/Hesdor.Domain/"]
COPY ["server-side/Hesdor.Infrastructure/Hesdor.Infrastructure.csproj", "server-side/Hesdor.Infrastructure/"]
COPY ["server-side/Hesdor.Infrastructure.Tests/Hesdor.Infrastructure.Tests.csproj", "server-side/Hesdor.Infrastructure.Tests/"]
COPY Hesdor.sln .
RUN dotnet restore server-side/Hesdor.Api/Hesdor.Api.csproj
COPY server-side/ server-side/
RUN dotnet publish server-side/Hesdor.Api/Hesdor.Api.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Hesdor.Api.dll"]
