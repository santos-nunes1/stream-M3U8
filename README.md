# Stream M3U8 Proxy Player

Aplicação web para reproduzir streams IPTV/M3U8 com um proxy HTTP próprio e buffer de segmentos HLS no backend. A interface permite abrir links diretos, carregar playlists M3U/M3U8, pesquisar canais, filtrar por grupo/categoria e reproduzir o stream selecionado no navegador.

## Recursos

- Player web com suporte a HLS, MPEG-TS e mídias nativas do navegador.
- Proxy backend para evitar expor URLs originais diretamente ao player.
- Modos de reprodução `auto`, `direct` e `proxy`.
- Buffer HLS em disco, com limpeza automática e janela live para atraso controlado.
- Leitura de playlist por URL, arquivo local ou texto colado.
- Suporte a playlists M3U Plus com nome, logo, grupo e classificação básica.
- Cache de playlist pré-carregada para abrir listas grandes com mais rapidez.
- Acesso por URL única com hash, sessões ativas e limite configurável de telas por usuário.
- Filtro de conteúdo adulto por usuário, ocultando canais adultos quando a permissão estiver desativada.
- Página administrativa protegida em `/admin.html` para criar, editar, remover usuários e gerar links.
- Robô opcional no Telegram com Pix Mercado Pago para vender planos e enviar links automaticamente.
- Execução local com Python ou em container Docker.

## Requisitos

- Python 3.12 ou superior.
- Navegador moderno.
- Docker e Docker Compose, opcional para execução em container.

O backend usa apenas a biblioteca padrão do Python. No frontend, `hls.js` e `mpegts.js` são carregados via CDN.

## Executar Localmente

Na raiz do projeto, execute:

```bash
python -m backend.app
```

Acesse a aplicação em:

```text
http://localhost:8000
```

Por padrão, o servidor escuta em `0.0.0.0:8000`. Isso permite acessar a aplicação por outro dispositivo na mesma rede Wi-Fi usando o IP local exibido no terminal:

```text
http://192.168.0.10:8000
```

## Executar com Docker

Suba a aplicação com Docker Compose:

```bash
docker compose up --build
```

Depois acesse:

```text
http://localhost:8000
```

O `docker-compose.yaml` usa o volume nomeado `stream_m3u8_data` em `/app/data` para persistir banco, playlist e cache. Faça backup desse volume antes de atualizar a aplicação.

Para acessar pela rede local, use o IP da máquina host com a porta `8000`. Não use o IP interno do container, como `172.x.x.x`.

## Como Usar

1. Configure `AUTH_ADMIN_TOKEN` no ambiente.
2. Acesse `http://localhost:8000/admin.html` e crie um usuário.
3. Copie a URL única gerada para esse usuário.
4. Abra a URL única, por exemplo `http://localhost:8000/access/<hash>`.
5. Use a busca e os filtros de categoria/grupo para encontrar o stream desejado.
6. Em `Series`, abra uma série para navegar por temporadas e episódios.
7. Escolha o modo de reprodução no player.
8. Clique em um item da lista para iniciar a reprodução.
9. Use `Parar` para encerrar o stream ativo.

## Acesso por URL, Sessões e Telas

O app usa uma URL única por usuário. Essa URL contém um `access_hash` aleatório salvo no banco. Ao abrir o link, o frontend troca o hash por um token assinado no formato JWT (`HS256`) e cria uma sessão ativa. Usuários e sessões ficam em um banco SQLite persistido no volume Docker. O arquivo padrão é `/app/data/auth.sqlite3` no container, ou `data/auth.sqlite3` fora do Docker.

Cada link de acesso tem data de expiração. Por padrão, a validade é de `30` dias a partir da criação, mas esse valor pode ser alterado na tela administrativa pelo campo `Validade do link`.

Fluxo implementado:

```text
Usuário
    ↓
Abre URL única /access/<hash>
    ↓
Validação do hash no banco
    ↓
Verificação da data de expiração
    ↓
Criação da sessão
    ↓
JWT de acesso
    ↓
Player Web
    ↓
Heartbeat a cada 30 segundos
    ↓
Controle de sessões simultâneas
```

Cada abertura válida da URL cria ou reutiliza uma sessão por dispositivo. O backend envia a sessão em cookie `HttpOnly`, `SameSite=Lax` e, quando publicado em HTTPS, `Secure`. A cada 30 segundos, o navegador chama `/api/auth/heartbeat`; o token é renovado por cookie e a contagem de telas usa o lease curto de `AUTH_SCREEN_LEASE_SECONDS`.

Formatos aceitos:

- `/access/<hash>`
- `/u/<hash>`
- `/?access=<hash>`
- `/?token=<hash>`
- Colar a URL completa ou apenas o hash no card de acesso.

O limite de telas é por usuário:

- `max_screens`: campo salvo no usuário.
- `AUTH_DEFAULT_MAX_SCREENS`: valor usado quando a criação não informar outro limite. Padrão: `2`.
- Se um usuário já tiver o número máximo de sessões ativas, uma nova abertura da URL recebe erro de limite atingido.

Validade do link:

- `access_expires_at`: data/hora de expiração salva no usuário.
- `access_expires_in_days`: campo usado na criação para definir a validade em dias.
- `AUTH_DEFAULT_ACCESS_DAYS`: valor padrão usado quando a criação não informar validade. Padrão: `30`.
- Quando o link expira, o login por hash retorna erro de link expirado e nenhuma nova sessão é criada.

Gerenciamento de usuários:

- A página `/admin.html` permite criar, editar e remover usuários com nome, e-mail, limite de telas, validade do link, status ativo e permissão de conteúdo adulto.
- Ao criar um usuário, a API gera e retorna a URL única desse usuário automaticamente.
- O acesso administrativo exige `AUTH_ADMIN_TOKEN`. Se ele não estiver configurado, o backend bloqueia a área de gerenciamento.
- O bot Telegram/Pix usa `POST /api/admin/users` internamente para emitir links depois de pagamentos aprovados.

## Conteúdo Adulto

Cada usuário possui a flag `allow_adult_content`.

- Quando `false`, o backend remove conteúdo adulto antes da paginação e dos contadores da playlist.
- Quando `true`, o usuário vê a playlist completa.
- A detecção usa termos no título, grupo, categoria e URL, como `adulto`, `xxx`, `porn`, `sexo`, `erotico`, `hot`, `playboy`, `onlyfans` e `18+`.

Esse filtro é aplicado no backend para a playlist pré-carregada e playlists carregadas manualmente. A UI mostra no topo se conteúdo adulto está `ativado` ou `bloqueado` para o usuário logado.

## Modos de Reprodução

- `auto`: tenta reproduzir a URL diretamente no navegador e usa o proxy como fallback se o player falhar. É o modo padrão.
- `direct`: o navegador acessa a origem do stream diretamente. Reduz o consumo de banda da VPS, mas pode falhar por CORS, User-Agent, bloqueio de origem ou formato incompatível.
- `proxy`: usa o backend como proxy direto. Para MPEG-TS/live, o backend repassa a mídia e o player aplica pré-buffer e controle de atraso.

O botão `Abrir player externo` usa o seletor ao lado para tentar abrir VLC ou Outplayer com uma URL temporária e tokenizada do backend. A URL original do stream não é enviada para o navegador nem baixada em playlist. Em celulares, a aplicação redireciona para a loja do app escolhido quando possível; no desktop, apenas tenta abrir o protocolo do player e informa caso o navegador não confirme a abertura.

## Playlist Pré-Carregada

A aplicação pode carregar uma playlist salva em `data/preloaded_playlist.m3u`. Esse arquivo é ignorado pelo Git para evitar versionar listas privadas ou arquivos muito grandes.

Para baixar e preparar uma playlist a partir de uma URL:

```bash
PLAYLIST_URL="https://exemplo.com/lista.m3u" python scripts/cache_playlist.py
```

Esse comando gera:

- `data/preloaded_playlist.m3u`
- `data/preloaded_playlist.m3u.entries.pickle`
- `data/preloaded_playlist.m3u.catalog.pickle`
- `data/preloaded_playlist.m3u.entries.json` quando a playlist estiver abaixo de `PLAYLIST_PARSED_CACHE_MAX_BYTES`
- `data/preloaded_playlist.m3u.sha256`

Também é possível configurar `PLAYLIST_CACHE_URL` no arquivo `.env` e usar o botão `Baixar e cachear minha playlist` na interface. A aplicação baixa a playlist, atualiza os arquivos em `data/` e carrega a primeira página de resultados.

No Docker Compose, o próprio serviço `stream-m3u8` baixa, processa e carrega a playlist antes de abrir a porta HTTP. Assim, o site só fica acessível depois que a playlist já está pronta em memória. Depois disso, repete a atualização em background a cada 6 horas por padrão.

Se a playlist já estiver disponível localmente, salve o conteúdo em `data/preloaded_playlist.m3u` e gere o cache parseado com:

```bash
python scripts/cache_playlist.py
```

## Acesso pela Internet

O perfil `public` cria um túnel temporário com Cloudflare Tunnel:

```bash
docker compose --profile public up -d --build
docker logs -f stream-m3u8-public
```

O log do container `stream-m3u8-public` mostra uma URL pública no formato `https://...trycloudflare.com`. Qualquer pessoa com esse link pode acessar a aplicação enquanto o túnel estiver ativo.

Esse modo é útil para testes rápidos, mas não é a melhor opção para streaming contínuo. Para uso mais fluido pela internet, publique a aplicação em uma VPS com boa banda e exponha o serviço por HTTPS usando Caddy, Nginx ou outro reverse proxy.

## Robô Telegram com Pix

O perfil `bot` sobe um worker separado que conversa com usuários no Telegram, cria cobranças Pix no Mercado Pago e, quando o pagamento é aprovado por webhook, cria o usuário pela API administrativa da aplicação.

Variáveis mínimas:

```bash
TELEGRAM_BOT_TOKEN="token-do-bot"
MERCADO_PAGO_ACCESS_TOKEN="APP_USR-..."
MERCADO_PAGO_WEBHOOK_SECRET="segredo-do-webhook"
BOT_PUBLIC_BASE_URL="https://seu-dominio-do-bot"
APP_PUBLIC_BASE_URL="https://seu-dominio-do-stream"
AUTH_ADMIN_TOKEN="mesmo-token-admin-do-app"
```

Suba o bot:

```bash
docker compose --profile bot up -d --build
```

O worker expõe `POST /webhooks/mercadopago/<MERCADO_PAGO_WEBHOOK_SECRET>` na porta `8081`. Configure essa URL no painel do Mercado Pago. Para testes rápidos, o perfil `bot-public` cria um túnel temporário para o webhook:

```bash
docker compose --profile bot-public up -d --build
docker logs -f stream-m3u8-bot-public
```

Planos podem ser configurados por `PLANS_JSON`. Exemplo:

```bash
PLANS_JSON='[{"id":"basic_30","name":"30 dias","price":29.90,"days":30,"max_screens":1,"allow_adult_content":false}]'
```

Por padrão, o bot usa planos de 30 dias para 1 ou 2 telas. O banco de pedidos fica no volume `stream_m3u8_bot_data`, separado do banco principal de usuários.

## Variáveis de Ambiente

- `HOST`: host do servidor HTTP. Padrão: `0.0.0.0`.
- `PORT`: porta do servidor HTTP. Padrão: `8000`.
- `HOST_LAN_IP`: IP local usado apenas para exibir o link de acesso na rede quando executado em Docker.
- `STREAM_CACHE_ROOT`: diretório temporário dos segmentos HLS. Padrão: `/tmp/stream-buffer`.
- `STREAM_BUFFER_SECONDS`: janela aproximada de buffer para streams HLS ao vivo. Padrão: `150`.
- `STREAM_DOWNLOAD_TIMEOUT`: timeout para baixar playlists e segmentos. Padrão: `10`.
- `STREAM_PLAYBACK_MODE`: modo inicial do player. Valores: `auto`, `direct` ou `proxy`. Padrão: `auto`.
- `STREAM_POLL_INTERVAL`: intervalo de atualização do worker de buffer. Padrão: `0.5`.
- `STREAM_MAX_CACHE_BYTES`: limite aproximado do cache local. Padrão: `209715200`.
- `STREAM_PUBLIC_BASE_URL`: URL pública usada para montar links de proxy atrás de reverse proxy.
- `AUTH_DB_PATH`: caminho do banco de autenticação SQLite. Padrão no Docker: `/app/data/auth.sqlite3`.
- `AUTH_TOKEN_SECRET`: segredo usado para assinar tokens. Obrigatório no Docker/produção; use pelo menos 32 caracteres aleatórios.
- `AUTH_TOKEN_TTL_SECONDS`: validade do token/sessão. Padrão: `3600` (1 hora), respeitando o mínimo configurado por `AUTH_MIN_TOKEN_TTL_SECONDS`.
- `AUTH_SCREEN_LEASE_SECONDS`: tempo sem heartbeat para considerar uma tela/dispositivo inativo na contagem de telas. Padrão no Docker: `300` (5 minutos).
- `AUTH_SESSION_STALE_SECONDS`: fallback legado para o lease de tela quando `AUTH_SCREEN_LEASE_SECONDS` não estiver configurado.
- `AUTH_DEFAULT_MAX_SCREENS`: limite padrão de telas para novos usuários. Padrão: `2`.
- `AUTH_DEFAULT_ACCESS_DAYS`: validade padrão, em dias, para novos links de acesso. Padrão: `30`.
- `AUTH_ADMIN_TOKEN`: token exigido pela tela `/admin.html` e pelas rotas `/api/admin/*`.
- `AUTH_REGISTRATION_TOKEN`: token legado; também é aceito como fallback administrativo quando `AUTH_ADMIN_TOKEN` não estiver configurado.
- `TELEGRAM_BOT_TOKEN`: token do BotFather para o worker Telegram.
- `MERCADO_PAGO_ACCESS_TOKEN`: token de acesso do Mercado Pago usado para criar e consultar cobranças Pix.
- `MERCADO_PAGO_WEBHOOK_SECRET`: segredo usado no caminho do webhook do Mercado Pago.
- `BOT_PUBLIC_BASE_URL`: URL pública HTTPS que aponta para o worker do bot.
- `APP_PUBLIC_BASE_URL`: URL pública da aplicação enviada aos usuários nos links de acesso.
- `PLANS_JSON`: lista JSON de planos vendidos pelo bot.
- `VLC_PROXY_TOKEN_TTL_SECONDS`: validade dos tokens temporários usados pelo botão `Abrir player externo`. Padrão: `21600`.
- `STREAM_USER_AGENT`: User-Agent enviado às origens dos streams.
- `STREAM_INSECURE_SSL`: permite ignorar validação SSL quando definido como `true`, `1`, `yes` ou `on`.
- `STREAM_ENV`: defina como `production` para validar segredos fortes no startup.
- `STREAM_ALLOW_PRIVATE_SOURCE_URLS`: por padrão o app bloqueia URLs internas/privadas para evitar SSRF. Use somente em ambiente controlado de desenvolvimento.
- `MAX_JSON_BODY_BYTES`, `MAX_PLAYLIST_TEXT_BYTES`, `MAX_REMOTE_PLAYLIST_BYTES`: limites de payload/download para proteger memória e disco.
- `RATE_LIMIT_DEFAULT_PER_MINUTE`, `RATE_LIMIT_AUTH_PER_MINUTE`, `RATE_LIMIT_MEDIA_PER_MINUTE`: limites simples por IP aplicados pelo backend. Em produção, combine com rate limit no reverse proxy.
- `STREAM_ORIGIN_TEMPLATE`: template para resolver IDs curtos, por exemplo `https://host/streams/{stream_id}.m3u8`.
- `STREAM_SOURCE_MAP`: JSON com mapeamento de `stream_id` para URL de origem.
- `PLAYLIST_FETCH_TIMEOUT`: timeout para carregar playlists grandes. Padrão: `45` no app e `90` no script.
- `PRELOADED_PLAYLIST_PATH`: caminho onde a playlist baixada fica persistida. Padrão: `data/preloaded_playlist.m3u`.
- `PLAYLIST_CACHE_URL`: URL baixada no startup para sobrescrever e preparar a playlist antes de servir HTTP.
- `PLAYLIST_REQUIRED_ON_STARTUP`: impede o servidor web de subir se a playlist local não estiver pronta. Padrão: `true`.
- `PLAYLIST_MAX_AGE_SECONDS`: idade máxima para considerar a playlist local fresca no startup e na atualização periódica. Padrão: `21600` (6 horas).
- `PLAYLIST_REFRESH_ON_STARTUP`: baixa e prepara a playlist no startup quando `PLAYLIST_CACHE_URL` estiver configurada e a playlist local estiver vencida. Padrão: `true`.
- `PLAYLIST_LOAD_BEFORE_SERVING`: quando `true`, espera a playlist ficar pronta antes de servir HTTP. Padrão: `true`, para liberar o app público apenas com o catálogo em memória.
- `PLAYLIST_REFRESH_REQUIRED_ON_STARTUP`: no modo bloqueante, encerra o servidor se o download inicial falhar. Padrão: `true`.
- `PLAYLIST_PARSED_CACHE_MAX_BYTES`: tamanho máximo da playlist para também gravar cache JSON parseado. O cache binário rápido é sempre usado pelo parser. Padrão: `52428800`.
- `PLAYLIST_REFRESH_INTERVAL_SECONDS`: intervalo entre atualizações automáticas da playlist. Padrão: `21600` (6 horas). Use `0` para desativar a atualização periódica.

## Endpoints Principais

- `GET /`: serve o frontend.
- `GET /admin.html`: página de gerenciamento de usuários.
- `GET /api/config`: retorna configurações públicas do frontend, como o modo inicial de reprodução.
- `GET /healthz`: indica que o processo HTTP está vivo.
- `GET /readyz`: indica se a playlist pré-carregada está pronta; em produção, o healthcheck usa este endpoint para só expor o app quando o conteúdo estiver carregado.
- `GET /api/auth/me`: valida o token atual e retorna usuário, sessão e quantidade de sessões ativas.
- `GET /api/admin/users`: lista usuários e links de acesso usando `X-Admin-Token`.
- `POST /api/admin/users`: cria usuário com `name`, `email`, `max_screens`, `access_expires_in_days` e `allow_adult_content`, retornando `access_url`.
- `PUT /api/admin/users/{id}`: altera usuário, validade do link, permissões e status ativo.
- `DELETE /api/admin/users/{id}`: remove usuário e sessões.
- `POST /api/admin/users/{id}/rotate-link`: gera um novo link de acesso.
- `POST /api/auth/link-login`: valida `access_hash`, cria sessão e retorna JWT.
- `POST /api/auth/login`: rota legada por e-mail/senha, mantida para compatibilidade interna.
- `POST /api/auth/heartbeat`: mantém a sessão ativa.
- `POST /api/auth/logout`: revoga a sessão atual.
- `POST /api/events/content-request`: registra nos logs qual conteúdo o usuário tentou reproduzir.
- `POST /api/vlc/open`: cria um token temporário usado por players externos sem expor a URL original.
- `POST /stream/start`: inicia o proxy/buffer para `{ "stream_id": "URL ou ID" }`.
- `POST /stream/stop`: encerra o stream ativo para `{ "stream_id": "URL ou ID" }`.
- `POST /api/playlist/parse`: carrega e pagina uma playlist por `url`, `text` ou `playlist_id`.
- `POST /api/playlist/preloaded`: carrega a playlist salva em `data/preloaded_playlist.m3u`.
- `POST /api/playlist/cache-default`: baixa a URL configurada em `PLAYLIST_CACHE_URL`, salva o cache local e retorna a primeira página.
- `GET /proxy/{stream_id}/playlist.m3u8`: playlist HLS local gerada pelo backend.
- `GET /vlc-proxy/{token}`: proxy temporário usado por players externos.
- `GET /media-proxy?vt=<token>`: proxy tokenizado para mídias como `.ts` e `.mp4`.

## Segurança e Privacidade

- Não versione playlists reais, credenciais, tokens ou URLs privadas.
- Configure `AUTH_TOKEN_SECRET` antes de expor o app publicamente.
- Configure `AUTH_ADMIN_TOKEN` antes de usar a tela de gerenciamento, especialmente se a aplicação estiver acessível pela internet.
- A pasta `data` é ignorada por padrão para evitar versionar playlists, caches, pickles, banco SQLite e credenciais embutidas em URLs.
- Nunca exponha `/media-proxy` sem token. O backend rejeita URL crua e bloqueia destinos privados/localhost por padrão.
- O banco SQLite fica no volume/pasta `data`. Para usar banco externo no futuro, mantenha os mesmos campos de usuários e sessões e substitua a camada `AuthStore`.
- O acesso público deve ser protegido por rede confiável, autenticação externa ou proxy reverso quando usado fora de testes.
- Os logs de reprodução mostram o nome do conteúdo e um `stream_ref` curto, sem imprimir a URL original do stream.
- Durante o cache da playlist, os logs exibem eventos `playlist_cache_progress` com fase e progresso do download.
- A reprodução depende do navegador, da estabilidade da origem e de possíveis bloqueios por User-Agent, geolocalização ou limite de conexões.
