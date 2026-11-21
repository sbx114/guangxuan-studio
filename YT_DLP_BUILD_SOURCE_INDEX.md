# yt-dlp 2026.10.26 Windows x64 构建源码索引

本索引从官方固定标签的 build.yml、curl-cffi.txt、win-x64-pyinstaller.txt 与 pip.txt 核对版本，并读取官方 PyPI 元信息取得精确源码包地址、大小及 SHA256。它是构建环境清单，不代表所有安装进构建环境的包都进入最终 EXE，也不代表底层 C 库已经全部在这些 Python 源码包内。

| 包 | 固定版本 | Windows x64 CPython 构建用途 | 官方源码包 |
| --- | --- | --- | --- |
| altgraph | 0.17.5 | 构建工具或其依赖 | [altgraph-0.17.5.tar.gz](https://files.pythonhosted.org/packages/7e/f8/97fdf103f38fed6792a1601dbc16cc8aac56e7459a9fff08c812d8ae177a/altgraph-0.17.5.tar.gz) |
| brotli | 1.2.1 | 安装的运行依赖 | [brotli-1.2.1.tar.gz](https://files.pythonhosted.org/packages/cf/81/1546c983678a9b4e77cb4718eaedd1b2caf24a6cdbf1eb8775938d22aff7/brotli-1.2.1.tar.gz) |
| brotlicffi | 1.2.1.0 | 条件排除（其他平台/解释器） | [brotlicffi-1.2.1.0.tar.gz](https://files.pythonhosted.org/packages/92/8b/10c6c4bac3a7d292707c9b879b8b3bb7f6c8ca5db5e6dff559bd9d59d45e/brotlicffi-1.2.1.0.tar.gz) |
| certifi | 2026.10.23 | 安装的运行依赖 | [certifi-2026.10.23.tar.gz](https://files.pythonhosted.org/packages/fd/11/b524cbd9bbdaca58608e4cf4053fd463417549e1959fa8d3aa18319f9555/certifi-2026.10.23.tar.gz) |
| cffi | 2.1.1 | 安装的运行依赖 | [cffi-2.1.1.tar.gz](https://files.pythonhosted.org/packages/9e/ef/008a1939e372c06329a3fce4279c02f328488f3526744906eeec3da7ad5f/cffi-2.1.1.tar.gz) |
| charset-normalizer | 3.5.2 | 安装的运行依赖 | [charset_normalizer-3.5.2.tar.gz](https://files.pythonhosted.org/packages/33/1c/f41d4e74c28ab327ff3acd36053f7ea506c55872d7a90b0fa71aa3ab0c89/charset_normalizer-3.5.2.tar.gz) |
| curl-cffi | 0.17.0 | 安装的运行依赖 | [curl_cffi-0.17.0.tar.gz](https://files.pythonhosted.org/packages/96/4c/69074f9797d83a5401b3c6bc58c5de5aad6d1a085d0497b87a093a152e87/curl_cffi-0.17.0.tar.gz) |
| idna | 3.20 | 安装的运行依赖 | [idna-3.20.tar.gz](https://files.pythonhosted.org/packages/f5/08/8eea9d4b8302028f3abb2c0813953f7aec26d33b7a8960ed760e65ff29fa/idna-3.20.tar.gz) |
| macholib | 1.16.4 | 条件排除（其他平台/解释器） | [macholib-1.16.4.tar.gz](https://files.pythonhosted.org/packages/10/2f/97589876ea967487978071c9042518d28b958d87b17dceb7cdc1d881f963/macholib-1.16.4.tar.gz) |
| mutagen | 1.48.1 | 安装的运行依赖 | [mutagen-1.48.1.tar.gz](https://files.pythonhosted.org/packages/df/70/1675da133ea92227da41bf5b24e1c66be597ff736a1533ade41da986852f/mutagen-1.48.1.tar.gz) |
| packaging | 26.3 | 构建工具或其依赖 | [packaging-26.3.tar.gz](https://files.pythonhosted.org/packages/7d/fa/3944b40b07da9ce895c0e6303a5ab7d53da063554f534556b134a54d6093/packaging-26.3.tar.gz) |
| pefile | 2024.8.26 | 构建工具或其依赖 | [pefile-2024.8.26.tar.gz](https://files.pythonhosted.org/packages/03/4f/2750f7f6f025a1507cd3b7218691671eecfd0bbebebe8b39aa0fe1d360b8/pefile-2024.8.26.tar.gz) |
| pip | 26.2.2 | 构建工具或其依赖 | [pip-26.2.2.tar.gz](https://files.pythonhosted.org/packages/fa/e8/0842d757e483e895e670f655084cfe8b8c72580c6769a76b30b2789a0608/pip-26.2.2.tar.gz) |
| pycparser | 3.11 | 安装的运行依赖 | [pycparser-3.11.tar.gz](https://files.pythonhosted.org/packages/da/a8/c5fdbeee588bb8ada9458774f43adf1bdd30bd59157055142183e769a024/pycparser-3.11.tar.gz) |
| pycryptodomex | 3.24.1 | 安装的运行依赖 | [pycryptodomex-3.24.1.tar.gz](https://files.pythonhosted.org/packages/f4/e7/50e72301e32acb73a314e663c2014e1ddefc019d5f434ff14ec89861d664/pycryptodomex-3.24.1.tar.gz) |
| pyinstaller-hooks-contrib | 2026.8 | 构建工具或其依赖 | [pyinstaller_hooks_contrib-2026.8.tar.gz](https://files.pythonhosted.org/packages/c9/3b/fab1a12a21bf9223af012e5dd002b7d4265683d21d9fabbd0ccb347316e4/pyinstaller_hooks_contrib-2026.8.tar.gz) |
| pywin32-ctypes | 0.2.3 | 构建工具或其依赖 | [pywin32-ctypes-0.2.3.tar.gz](https://files.pythonhosted.org/packages/85/9f/01a1a99704853cb63f253eea009390c88e7131c67e66a0a02099a8c917cb/pywin32-ctypes-0.2.3.tar.gz) |
| requests | 2.34.2 | 安装的运行依赖 | [requests-2.34.2.tar.gz](https://files.pythonhosted.org/packages/ac/c3/e2a2b89f2d3e2179abd6d00ebd70bff6273f37fb3e0cc209f48b39d00cbf/requests-2.34.2.tar.gz) |
| setuptools | 84.2.1 | 构建工具或其依赖 | [setuptools-84.2.1.tar.gz](https://files.pythonhosted.org/packages/70/b3/c19426f783614d625699a4b247faf628ea9ab1db228674491767b417f9e1/setuptools-84.2.1.tar.gz) |
| urllib3 | 2.8.0 | 安装的运行依赖 | [urllib3-2.8.0.tar.gz](https://files.pythonhosted.org/packages/e3/05/b17359e1cefb4f909b5e40b1b90a496d987258916dbbf88e842c729f510e/urllib3-2.8.0.tar.gz) |
| websockets | 17.3 | 安装的运行依赖 | [websockets-17.3.tar.gz](https://files.pythonhosted.org/packages/30/4b/4692be6d5bf739ed049b3813901c42091f8c054df89d5c089343823dea0d/websockets-17.3.tar.gz) |
| yt-dlp-ejs | 0.8.0 | 安装的运行依赖 | [yt_dlp_ejs-0.8.0.tar.gz](https://files.pythonhosted.org/packages/d3/e6/cceb9530e8f4e5940f6f7822d90e9d94f1b85343329a16baaf47bbbb3de1/yt_dlp_ejs-0.8.0.tar.gz) |

此外，官方 Windows x64 PyInstaller 包固定为 **6.22.0**，来自 [yt-dlp/Pyinstaller-Builds 2026.08.19.215425](https://github.com/yt-dlp/Pyinstaller-Builds/releases/tag/2026.08.19.215425)，其发行正文明确标记对应 [PyInstaller 源码提交 70fc17210920bce17f4ab09bbf8104b0dbd45338](https://github.com/pyinstaller/pyinstaller/commit/70fc17210920bce17f4ab09bbf8104b0dbd45338)。固定 wheel 的 SHA256 为 `294099ecb5fdd2a13ae4c29006d4e335b697a63b6a16cf052b90ec2b40bef05a`。

官方 workflow 使用 Python **3.14** 且 `check-latest: true`；因此 workflow 本身没有固定 patch 版本。不得凭此推断最终 EXE 的 Python patch。

机器可读来源、完整校验值和元信息字段见 `yt-dlp-2026.10.26-build-dependency-sources.json`。对应的官方完整许可见 `ytdlp-THIRD_PARTY_LICENSES.txt`。curl-cffi 所合并的 curl、TLS 与压缩库还需按其构建材料分别核对，不能用上述包版本替代底层源树。
