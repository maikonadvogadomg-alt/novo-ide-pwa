import React, { useState, useCallback } from "react";
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  ScrollView, Linking, Alert, ActivityIndicator, StyleSheet,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import {
  createRepo, pushFiles, enablePages, makeRepoPublic, getUser,
} from "@/services/githubService";

interface Props {
  visible: boolean;
  onClose: () => void;
}

type Tab = "pwabuilder" | "actions";
type BuildStep = "idle" | "building" | "done" | "error";

export default function APKBuilderModal({ visible, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { activeProject, gitConfigs } = useApp();

  const [tab, setTab] = useState<Tab>("pwabuilder");
  const [pagesUrl, setPagesUrl] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlInput, setUrlInput] = useState("");

  // GitHub Actions tab
  const [repoName, setRepoName] = useState("");
  const [step, setStep] = useState<BuildStep>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [actionsUrl, setActionsUrl] = useState("");
  const [error, setError] = useState("");

  const ghConfig = gitConfigs.find(g => g.provider === "github");
  const token = ghConfig?.token || "";
  const hasToken = !!token;

  const sanitize = (s: string) =>
    s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  const appName = activeProject?.name || "Meu App";
  const defaultRepo = sanitize(appName) || "meu-app";

  const log = (msg: string) => setLogs(l => [...l, msg]);

  // ── Build via GitHub Actions ──────────────────────────────────────────
  const handleBuildAPK = useCallback(async () => {
    if (!hasToken) {
      Alert.alert("Token necessário", "Configure seu token GitHub em Menu → GitHub primeiro.");
      return;
    }
    if (!activeProject || activeProject.files.length === 0) {
      Alert.alert("Projeto vazio", "Abra um projeto com arquivos antes de gerar o APK.");
      return;
    }

    const repo = (repoName.trim() || defaultRepo).toLowerCase().replace(/[^a-z0-9-]/g, "");
    setStep("building");
    setLogs(["🚀 Iniciando…"]);
    setError("");
    setActionsUrl("");

    try {
      const user = await getUser(token);
      const owner = user.login;
      log(`👤 Usuário: ${owner}`);

      // 1. Criar repositório
      log(`📁 Criando repositório "${repo}"…`);
      try {
        await createRepo(token, repo, `${appName} — gerado pelo DevMobile`, false);
        log("✅ Repositório criado.");
      } catch (e: any) {
        if (e.message?.includes("422") || e.message?.includes("already exists") || e.message?.includes("name already exists")) {
          log("ℹ️ Repositório já existe — usando existente.");
        } else throw e;
      }

      await makeRepoPublic(token, owner, repo);
      log("🌐 Repositório público.");

      const pUrl = `https://${owner}.github.io/${repo}/`;

      // 2. Montar arquivos
      const manifest = JSON.stringify({
        name: appName,
        short_name: appName.split(" ")[0],
        start_url: "./",
        display: "standalone",
        background_color: "#0d1117",
        theme_color: "#0d1117",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      }, null, 2);

      const deployWf = `name: Deploy GitHub Pages
on:
  push:
    branches: [main, master]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: "."
      - id: deployment
        uses: actions/deploy-pages@v4
`;

      const apkWf = `name: Build APK Android
on:
  workflow_dispatch:
  workflow_run:
    workflows: ["Deploy GitHub Pages"]
    types: [completed]
permissions:
  contents: write
jobs:
  build-apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install -g @bubblewrap/cli@latest
      - name: Gerar keystore
        run: |
          keytool -genkey -v -keystore android.keystore -alias app \\
            -keyalg RSA -keysize 2048 -validity 10000 \\
            -storepass mypassword123 -keypass mypassword123 \\
            -dname "CN=${appName}, OU=App, O=App, L=BR, ST=BR, C=BR"
      - name: Config TWA
        run: |
          cat > twa-manifest.json << 'EOF'
          {
            "packageId": "com.${owner.replace(/[^a-z0-9]/gi, "").toLowerCase()}.${repo.replace(/[^a-z0-9]/g, "")}",
            "host": "${owner}.github.io",
            "name": "${appName}",
            "launcherName": "${appName.split(" ")[0]}",
            "display": "standalone",
            "themeColor": "#0d1117",
            "navigationColor": "#0d1117",
            "backgroundColor": "#0d1117",
            "enableNotifications": false,
            "startUrl": "/${repo}/",
            "iconUrl": "${pUrl}icon-192.png",
            "maskableIconUrl": "${pUrl}icon-192.png",
            "appVersion": "1.0.0",
            "appVersionCode": 1,
            "signingKey": { "path": "../android.keystore", "alias": "app" },
            "shortcuts": [],
            "generatorApp": "bubblewrap-cli",
            "webManifestUrl": "${pUrl}manifest.json",
            "fallbackType": "customtabs",
            "features": {},
            "minSdkVersion": 21,
            "orientation": "default",
            "fullScopeUrl": "${pUrl}"
          }
          EOF
      - run: |
          bubblewrap init --manifest twa-manifest.json --directory ./twa-app
          cd twa-app && bubblewrap build
        env:
          BUBBLEWRAP_KEYSTORE_PASSWORD: mypassword123
          BUBBLEWRAP_KEY_PASSWORD: mypassword123
      - uses: actions/upload-artifact@v4
        with:
          name: APK-Android
          path: "**/*.apk"
          retention-days: 30
`;

      // 3. Montar lista de arquivos
      const fileList: Array<{ path: string; content: string }> = [
        { path: "manifest.json", content: manifest },
        { path: ".github/workflows/deploy.yml", content: deployWf },
        { path: ".github/workflows/build-apk.yml", content: apkWf },
        ...activeProject.files.map(f => ({ path: f.path || f.name, content: f.content || "" })),
      ];

      log(`📤 Enviando ${fileList.length} arquivo(s)…`);
      await pushFiles(token, owner, repo, fileList, `${appName} — DevMobile`);
      log("✅ Arquivos enviados.");

      // 4. Ativar Pages
      log("🌐 Ativando GitHub Pages…");
      try {
        await enablePages(token, owner, repo);
        log(`✅ Pages ativo: ${pUrl}`);
      } catch {
        log("ℹ️ Pages já ativo ou aguardando.");
      }

      log("⏳ Aguarde ~3 min para o site e ~10 min para o APK.");
      log(`📥 Baixe o APK em: Actions → Build APK Android → Artifacts`);

      setPagesUrl(pUrl);
      setActionsUrl(`https://github.com/${owner}/${repo}/actions`);
      setStep("done");
    } catch (e: any) {
      setError(e.message || String(e));
      setStep("error");
    }
  }, [token, activeProject, repoName, defaultRepo, appName]);

  const handleSaveUrl = () => {
    let url = urlInput.trim();
    if (url && !url.endsWith("/")) url += "/";
    setPagesUrl(url);
    setEditingUrl(false);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[s.root, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[s.header, { borderBottomColor: colors.border, paddingTop: insets.top + 8 }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: "#f97316" + "22", alignItems: "center", justifyContent: "center" }}>
              <Feather name="smartphone" size={16} color="#f97316" />
            </View>
            <View>
              <Text style={[s.title, { color: colors.foreground }]}>Gerar APK Android</Text>
              {activeProject && (
                <Text style={[s.subtitle, { color: colors.mutedForeground }]}>{activeProject.name}</Text>
              )}
            </View>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="x" size={22} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 40 }}>

          {/* Link do site */}
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={[s.label, { color: colors.mutedForeground }]}>LINK DO SITE PUBLICADO</Text>
              <TouchableOpacity onPress={() => { setEditingUrl(true); setUrlInput(pagesUrl); }}>
                <Text style={{ fontSize: 12, color: colors.primary }}>✏️ editar</Text>
              </TouchableOpacity>
            </View>
            {editingUrl ? (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <TextInput
                  autoFocus
                  value={urlInput}
                  onChangeText={setUrlInput}
                  onSubmitEditing={handleSaveUrl}
                  placeholder="https://usuario.github.io/meu-app/"
                  placeholderTextColor={colors.mutedForeground + "88"}
                  style={[s.input, { color: colors.foreground, borderColor: colors.primary, backgroundColor: colors.card, flex: 1 }]}
                />
                <TouchableOpacity
                  onPress={handleSaveUrl}
                  style={{ paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.primary, borderRadius: 10, justifyContent: "center" }}
                >
                  <Text style={{ color: "#fff", fontWeight: "700" }}>OK</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                onPress={() => { setEditingUrl(true); setUrlInput(pagesUrl); }}
                style={[s.urlBox, { backgroundColor: colors.card, borderColor: pagesUrl ? colors.border : "#f59e0b55" }]}
              >
                <Feather name="globe" size={13} color={pagesUrl ? colors.primary : "#f59e0b"} />
                <Text style={{ fontSize: 12, color: pagesUrl ? colors.foreground : "#f59e0b88", flex: 1 }} numberOfLines={1}>
                  {pagesUrl || "Toque para inserir o link do GitHub Pages…"}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Tabs */}
          <View style={[s.tabs, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {(["pwabuilder", "actions"] as Tab[]).map(t => (
              <TouchableOpacity
                key={t}
                onPress={() => setTab(t)}
                style={[s.tab, tab === t && { backgroundColor: t === "pwabuilder" ? "#3b82f622" : "#22c55e22", borderColor: t === "pwabuilder" ? "#3b82f644" : "#22c55e44", borderWidth: 1 }]}
              >
                <Feather
                  name={t === "pwabuilder" ? "package" : "git-branch"}
                  size={12}
                  color={tab === t ? (t === "pwabuilder" ? "#60a5fa" : "#4ade80") : colors.mutedForeground}
                />
                <Text style={{ fontSize: 12, fontWeight: "700", color: tab === t ? (t === "pwabuilder" ? "#60a5fa" : "#4ade80") : colors.mutedForeground }}>
                  {t === "pwabuilder" ? "PWABuilder" : "GitHub Actions"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* ── PWABuilder ── */}
          {tab === "pwabuilder" && (
            <View style={{ gap: 12 }}>
              <View style={[s.infoBox, { backgroundColor: "#3b82f611", borderColor: "#3b82f633" }]}>
                <Text style={[s.infoTitle, { color: "#60a5fa" }]}>Como funciona</Text>
                <Text style={[s.infoText, { color: colors.mutedForeground }]}>
                  O PWABuilder (Microsoft) analisa seu site publicado e gera o APK em menos de 1 minuto. Grátis, sem instalar nada.
                </Text>
              </View>

              {!pagesUrl ? (
                <View style={[s.infoBox, { backgroundColor: "#f59e0b11", borderColor: "#f59e0b33" }]}>
                  <Text style={[s.infoTitle, { color: "#f59e0b" }]}>⚠️ Precisa do link publicado</Text>
                  <Text style={[s.infoText, { color: colors.mutedForeground }]}>
                    Use a aba "GitHub Actions" para publicar, ou cole o link do GitHub Pages acima.
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => Linking.openURL(`https://www.pwabuilder.com/generate?url=${encodeURIComponent(pagesUrl)}`)}
                  style={[s.bigBtn, { backgroundColor: "#3b82f622", borderColor: "#3b82f644" }]}
                  activeOpacity={0.75}
                >
                  <Feather name="package" size={20} color="#60a5fa" />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#60a5fa", fontWeight: "700", fontSize: 15 }}>Abrir PWABuilder</Text>
                    <Text style={{ color: colors.mutedForeground, fontSize: 11 }} numberOfLines={1}>{pagesUrl}</Text>
                  </View>
                  <Feather name="external-link" size={14} color={colors.mutedForeground} />
                </TouchableOpacity>
              )}

              <Text style={[s.label, { color: colors.mutedForeground }]}>NO PWABUILDER:</Text>
              {["Clique em 'Start'", "Aguarde a análise do site", "Clique 'Package for stores'", "Selecione Android", "Clique 'Generate Package'", "Baixe e instale o .apk no celular"].map((t, i) => (
                <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                  <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: "#3b82f622", alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ color: "#60a5fa", fontSize: 10, fontWeight: "700" }}>{i + 1}</Text>
                  </View>
                  <Text style={{ color: colors.foreground, fontSize: 13, flex: 1 }}>{t}</Text>
                </View>
              ))}
            </View>
          )}

          {/* ── GitHub Actions ── */}
          {tab === "actions" && (
            <View style={{ gap: 12 }}>
              {!hasToken ? (
                <View style={[s.infoBox, { backgroundColor: "#f59e0b11", borderColor: "#f59e0b33" }]}>
                  <Text style={[s.infoTitle, { color: "#f59e0b" }]}>⚠️ Configure o GitHub primeiro</Text>
                  <Text style={[s.infoText, { color: colors.mutedForeground }]}>
                    Vá em Menu → GitHub — Clonar / Enviar e configure seu token de acesso.
                  </Text>
                </View>
              ) : (
                <>
                  <View style={[s.infoBox, { backgroundColor: "#22c55e11", borderColor: "#22c55e33" }]}>
                    <Text style={[s.infoTitle, { color: "#4ade80" }]}>O que vai acontecer</Text>
                    <Text style={[s.infoText, { color: colors.mutedForeground }]}>
                      Sobe o projeto no GitHub, ativa o Pages e dispara o build do APK nos servidores do GitHub. Você baixa o APK pronto na aba Actions.
                    </Text>
                  </View>

                  {step === "idle" && (
                    <>
                      <Text style={[s.label, { color: colors.mutedForeground }]}>NOME DO REPOSITÓRIO</Text>
                      <TextInput
                        value={repoName || defaultRepo}
                        onChangeText={t => setRepoName(sanitize(t))}
                        placeholder={defaultRepo}
                        placeholderTextColor={colors.mutedForeground + "88"}
                        style={[s.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <TouchableOpacity
                        onPress={handleBuildAPK}
                        style={[s.bigBtn, { backgroundColor: "#22c55e", borderColor: "#16a34a" }]}
                        activeOpacity={0.8}
                      >
                        <Feather name="zap" size={18} color="#fff" />
                        <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>Publicar e Gerar APK</Text>
                      </TouchableOpacity>
                    </>
                  )}

                  {step === "building" && (
                    <View style={{ gap: 10 }}>
                      <View style={[s.logBox, { backgroundColor: "#000", borderColor: colors.border }]}>
                        <ScrollView>
                          {logs.map((l, i) => (
                            <Text key={i} style={{ color: "#22c55e", fontSize: 11, fontFamily: "monospace", lineHeight: 18 }}>{l}</Text>
                          ))}
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                            <ActivityIndicator size="small" color="#22c55e" />
                            <Text style={{ color: "#22c55e88", fontSize: 11 }}>Processando…</Text>
                          </View>
                        </ScrollView>
                      </View>
                    </View>
                  )}

                  {step === "done" && (
                    <View style={{ gap: 10 }}>
                      <View style={[s.infoBox, { backgroundColor: "#22c55e11", borderColor: "#22c55e33" }]}>
                        <Text style={[s.infoTitle, { color: "#4ade80" }]}>✅ Publicado com sucesso!</Text>
                        <Text style={[s.infoText, { color: colors.mutedForeground }]}>
                          O GitHub está construindo o APK (~10 min). Baixe na aba Actions quando terminar.
                        </Text>
                      </View>
                      <View style={[s.logBox, { backgroundColor: "#000", borderColor: colors.border, maxHeight: 140 }]}>
                        <ScrollView>
                          {logs.map((l, i) => (
                            <Text key={i} style={{ color: "#22c55e", fontSize: 11, fontFamily: "monospace", lineHeight: 18 }}>{l}</Text>
                          ))}
                        </ScrollView>
                      </View>
                      {actionsUrl ? (
                        <TouchableOpacity
                          onPress={() => Linking.openURL(actionsUrl)}
                          style={[s.bigBtn, { backgroundColor: "#3b82f622", borderColor: "#3b82f644" }]}
                          activeOpacity={0.75}
                        >
                          <Feather name="git-branch" size={18} color="#60a5fa" />
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: "#60a5fa", fontWeight: "700", fontSize: 14 }}>Abrir Actions no GitHub</Text>
                            <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>Baixar APK quando terminar</Text>
                          </View>
                          <Feather name="external-link" size={14} color={colors.mutedForeground} />
                        </TouchableOpacity>
                      ) : null}
                      <TouchableOpacity onPress={() => { setStep("idle"); setLogs([]); }} style={{ alignItems: "center", paddingVertical: 8 }}>
                        <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>↩ Gerar novamente</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {step === "error" && (
                    <View style={{ gap: 10 }}>
                      <View style={[s.infoBox, { backgroundColor: "#ef444411", borderColor: "#ef444433" }]}>
                        <Text style={[s.infoTitle, { color: "#f87171" }]}>❌ Erro</Text>
                        <Text style={[s.infoText, { color: colors.mutedForeground }]}>{error}</Text>
                      </View>
                      <TouchableOpacity onPress={() => setStep("idle")} style={{ alignItems: "center", paddingVertical: 8 }}>
                        <Text style={{ color: colors.primary, fontSize: 13, fontWeight: "600" }}>Tentar novamente</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </>
              )}
            </View>
          )}

          {/* Dica instalar */}
          <View style={[s.infoBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[s.infoText, { color: colors.mutedForeground }]}>
              <Text style={{ color: colors.foreground, fontWeight: "700" }}>💡 Instalar no celular:</Text>
              {" "}Ative "Fontes desconhecidas" em Configurações → Segurança, depois abra o .apk.
            </Text>
          </View>

        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 16, fontWeight: "700" },
  subtitle: { fontSize: 12, marginTop: 1 },
  label: { fontSize: 10, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  urlBox: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  tabs: { flexDirection: "row", borderRadius: 12, padding: 4, gap: 4, borderWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 9, borderRadius: 9 },
  infoBox: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 },
  infoTitle: { fontSize: 12, fontWeight: "700" },
  infoText: { fontSize: 12, lineHeight: 18 },
  bigBtn: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 12, padding: 14 },
  logBox: { borderWidth: 1, borderRadius: 10, padding: 10, minHeight: 80, maxHeight: 200 },
});
