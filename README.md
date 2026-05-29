# Stream M3U8 Proxy

Aplicação web para reproduzir streams IPTV/M3U8 com um proxy HTTP próprio e buffer de segmentos HLS no backend. A interface permite abrir links diretos, carregar playlists M3U/M3U8, pesquisar canais, filtrar por grupo/categoria e reproduzir o stream selecionado no navegador.

## Recursos

- Player web com suporte a HLS, MPEG-TS e mídias nativas do navegador.
- Proxy backend para evitar expor URLs originais diretamente ao player.
- Modos de reprodução `auto`, `direct` e `proxy`.
- Buffer HLS em disco, com limpeza automática e janela configurável.
- Leitura de playlist por URL, arquivo local ou texto colado.
- Suporte a playlists M3U Plus com nome, logo, grupo e classificação básica.
- Cache de playlist pré-carregada para abrir listas grandes com mais rapidez.
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

O `docker-compose.yaml` monta a pasta `data` dentro do container para permitir leitura e atualização da playlist pré-carregada.

Para acessar pela rede local, use o IP da máquina host com a porta `8000`. Não use o IP interno do container, como `172.x.x.x`.

## Como Usar

1. Abra `http://localhost:8000` no navegador.
2. Para testar um link direto, cole uma URL `.m3u8`, `.ts`, `.mp4` ou similar no campo `Link direto` e clique em `Iniciar`.
3. Para navegar por uma playlist, informe uma URL, selecione um arquivo local ou cole o conteúdo M3U/M3U8 no campo de texto.
4. Use a busca e os filtros de categoria/grupo para encontrar o stream desejado.
5. Escolha o modo de reprodução no player.
6. Clique em um item da lista para iniciar a reprodução.
7. Use `Parar` para encerrar o stream ativo.

## Modos de Reprodução

- `auto`: tenta reproduzir a URL diretamente no navegador e usa o proxy como fallback se o player falhar. É o modo padrão.
- `direct`: o navegador acessa a origem do stream diretamente. Reduz o consumo de banda da VPS, mas pode falhar por CORS, User-Agent, bloqueio de origem ou formato incompatível.
- `proxy`: sempre usa o backend como proxy com buffer local. É mais compatível, mas consome banda do servidor para cada usuário assistindo.

## Playlist Pré-Carregada

A aplicação pode carregar uma playlist salva em `data/preloaded_playlist.m3u`. Esse arquivo é ignorado pelo Git para evitar versionar listas privadas ou arquivos muito grandes.

Para baixar e preparar uma playlist a partir de uma URL:

```bash
PLAYLIST_URL="https://exemplo.com/lista.m3u" python scripts/cache_playlist.py
```

Esse comando gera:

- `data/preloaded_playlist.m3u`
- `data/preloaded_playlist.m3u.entries.json`

Também é possível configurar `PLAYLIST_CACHE_URL` no arquivo `.env` e usar o botão `Baixar e cachear minha playlist` na interface. A aplicação baixa a playlist, atualiza os arquivos em `data/` e carrega a primeira página de resultados.

Quando `PLAYLIST_CACHE_URL` está configurada, o servidor baixa e prepara a playlist antes de abrir a porta HTTP. Depois disso, repete a atualização em background a cada 12 horas por padrão.

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

## Variáveis de Ambiente

- `HOST`: host do servidor HTTP. Padrão: `0.0.0.0`.
- `PORT`: porta do servidor HTTP. Padrão: `8000`.
- `HOST_LAN_IP`: IP local usado apenas para exibir o link de acesso na rede quando executado em Docker.
- `STREAM_CACHE_ROOT`: diretório temporário dos segmentos HLS. Padrão: `/tmp/stream-buffer`.
- `STREAM_BUFFER_SECONDS`: janela aproximada de buffer para streams HLS ao vivo. Padrão: `120`.
- `STREAM_DOWNLOAD_TIMEOUT`: timeout para baixar playlists e segmentos. Padrão: `10`.
- `STREAM_PLAYBACK_MODE`: modo inicial do player. Valores: `auto`, `direct` ou `proxy`. Padrão: `auto`.
- `STREAM_POLL_INTERVAL`: intervalo de atualização do worker de buffer. Padrão: `0.5`.
- `STREAM_MAX_CACHE_BYTES`: limite aproximado do cache local. Padrão: `209715200`.
- `STREAM_PUBLIC_BASE_URL`: URL pública usada para montar links de proxy atrás de reverse proxy.
- `STREAM_USER_AGENT`: User-Agent enviado às origens dos streams.
- `STREAM_INSECURE_SSL`: permite ignorar validação SSL quando definido como `true`, `1`, `yes` ou `on`.
- `STREAM_ORIGIN_TEMPLATE`: template para resolver IDs curtos, por exemplo `https://host/streams/{stream_id}.m3u8`.
- `STREAM_SOURCE_MAP`: JSON com mapeamento de `stream_id` para URL de origem.
- `PLAYLIST_FETCH_TIMEOUT`: timeout para carregar playlists grandes. Padrão: `45` no app e `90` no script.
- `PRELOADED_PLAYLIST_PATH`: caminho da playlist pré-carregada. Padrão: `data/preloaded_playlist.m3u`.
- `PLAYLIST_CACHE_URL`: URL usada pelo botão `Baixar e cachear minha playlist`.
- `PLAYLIST_REFRESH_ON_STARTUP`: baixa e prepara a playlist antes de servir HTTP quando `PLAYLIST_CACHE_URL` estiver configurada. Padrão: `true`.
- `PLAYLIST_REFRESH_REQUIRED_ON_STARTUP`: encerra o servidor se o download inicial falhar. Padrão: `true`.
- `PLAYLIST_REFRESH_INTERVAL_SECONDS`: intervalo entre atualizações automáticas da playlist. Padrão: `43200` (12 horas). Use `0` para desativar a atualização periódica.

## Endpoints Principais

- `GET /`: serve o frontend.
- `GET /api/config`: retorna configurações públicas do frontend, como o modo inicial de reprodução.
- `POST /api/events/content-request`: registra nos logs qual conteúdo o usuário tentou reproduzir.
- `POST /stream/start`: inicia o proxy/buffer para `{ "stream_id": "URL ou ID" }`.
- `POST /stream/stop`: encerra o stream ativo para `{ "stream_id": "URL ou ID" }`.
- `POST /api/playlist/parse`: carrega e pagina uma playlist por `url`, `text` ou `playlist_id`.
- `POST /api/playlist/preloaded`: carrega a playlist salva em `data/preloaded_playlist.m3u`.
- `POST /api/playlist/cache-default`: baixa a URL configurada em `PLAYLIST_CACHE_URL`, salva o cache local e retorna a primeira página.
- `GET /proxy/{stream_id}/playlist.m3u8`: playlist HLS local gerada pelo backend.
- `GET /media-proxy/{url}`: proxy direto para mídias como `.ts` e `.mp4`.

## Segurança e Privacidade

- Não versione playlists reais, credenciais, tokens ou URLs privadas.
- A pasta `data` já ignora arquivos `.m3u`, `.m3u8` e `.json`.
- O acesso público deve ser protegido por rede confiável, autenticação externa ou proxy reverso quando usado fora de testes.
- Os logs de reprodução mostram o nome do conteúdo e um `stream_ref` curto, sem imprimir a URL original do stream.
- Durante o cache da playlist, os logs exibem eventos `playlist_cache_progress` com fase e progresso do download.
- A reprodução depende do navegador, da estabilidade da origem e de possíveis bloqueios por User-Agent, geolocalização ou limite de conexões.
