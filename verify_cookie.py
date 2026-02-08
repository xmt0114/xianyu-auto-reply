import asyncio
import aiohttp
import time
import hashlib
import json
import base64
from urllib.parse import urlparse

# ==================== 工具函数 (从项目源码提取) ====================

def trans_cookies(cookies_str: str) -> dict:
    """将cookies字符串转换为字典"""
    if not cookies_str:
        return {}
        
    cookies = {}
    for cookie in cookies_str.split("; "):
        if "=" in cookie:
            key, value = cookie.split("=", 1)
            cookies[key] = value
    return cookies

def generate_sign(t: str, token: str, data: str) -> str:
    """生成签名"""
    app_key = "34839810"
    msg = f"{token}&{t}&{app_key}&{data}"
    
    # 使用MD5生成签名
    md5_hash = hashlib.md5()
    md5_hash.update(msg.encode('utf-8'))
    return md5_hash.hexdigest()

# ==================== 测试逻辑 ====================

async def check_cookie(cookie_str: str):
    print(f"[-] 正在检查 Cookie 格式...")
    
    cookies = trans_cookies(cookie_str)
    
    # 1. 检查关键字段
    required_fields = ['_m_h5_tk', '_m_h5_tk_enc', 'cookie2', 'unb']
    missing_fields = [f for f in required_fields if f not in cookies]
    
    if missing_fields:
        print(f"[X] 格式错误: 缺少关键字段 {missing_fields}")
        print("    请确保您复制了完整的 Cookie (包含 _m_h5_tk 等)。")
        return
    else:
        print(f"[+] 格式检查通过。")
        print(f"    用户ID (unb): {cookies.get('unb')}")
        token_full = cookies.get('_m_h5_tk', '')
        token_sections = token_full.split('_')
        print(f"    Token: {token_sections[0]}")
        if len(token_sections) > 1:
            expire_ts = int(token_sections[1])
            expire_time = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(expire_ts / 1000))
            print(f"    Token过期时间: {expire_time}")
            
            if expire_ts < time.time() * 1000:
                print(f"[!] 警告: Token 已过期！这会导致刷新请求失败。")
        else:
            print(f"[!] 警告: Token 格式异常，缺少时间戳。")

    # 2. 尝试模拟 Token 刷新请求
    print(f"\n[-] 正在尝试模拟 API 请求...")
    
    token = token_sections[0]
    t = str(int(time.time()) * 1000)
    device_id = "test-device-id" 
    
    params = {
        'jsv': '2.7.2',
        'appKey': '34839810',
        't': t,
        'sign': '',
        'v': '1.0',
        'type': 'originaljson',
        'accountSite': 'xianyu',
        'dataType': 'json',
        'timeout': '20000',
        'api': 'mtop.taobao.idlemessage.pc.login.token',
        'sessionOption': 'AutoLoginOnly',
    }
    
    data_val = '{"appKey":"444e9908a51d1cb236a27862abc769c9","deviceId":"' + device_id + '"}'
    data = {
        'data': data_val,
    }
    
    # 计算签名
    sign = generate_sign(t, token, data_val)
    params['sign'] = sign
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.goofish.com/", 
        "Cookie": cookie_str
    }
    
    url = "https://h5api.m.goofish.com/h5/mtop.taobao.idlemessage.pc.login.token/1.0/"
    
    async with aiohttp.ClientSession() as session:
        try:
            async with session.post(url, params=params, data=data, headers=headers) as response:
                print(f"[-] 请求状态码: {response.status}")
                res_text = await response.text()
                print(f"[-] 响应内容: {res_text[:200]}...") # 只显示前200字符
                
                try:
                    res_json = json.loads(res_text)
                    ret = res_json.get('ret', [])
                    if any('SUCCESS' in r for r in ret):
                        print(f"[+] API 测试成功！Cookie 有效。")
                    elif any('TOKEN_EXPIRED' in r for r in ret) or any('FAIL_SYS_TOKEN_EMPTY' in r for r in ret):
                         print(f"[X] API 测试失败: Token 无效或过期。请重新获取 Cookie。")
                    elif any('FAIL_SYS_ILLEGAL_ACCESS' in r for r in ret):
                         print(f"[X] API 测试失败: 非法访问，可能是风控或签名问题。")
                    else:
                         print(f"[?] API 测试返回未知状态: {ret}")
                         
                except json.JSONDecodeError:
                    print(f"[X] 响应不是有效的 JSON。")
                    
        except Exception as e:
            print(f"[X] 请求发生异常: {e}")

if __name__ == "__main__":
    import sys
    print("================== 闲鱼 Cookie 有效性检查工具 ==================")
    if len(sys.argv) > 1:
        # 优先读取命令行参数（如果有）
        c_str = sys.argv[1]
    else:
        print("请输入您的 Cookie 字符串 (按回车结束):")
        c_str = input().strip()
    
    if not c_str:
        print("未输入 Cookie，程序退出。")
    else:
        # 去除引号 (如果用户复制带了)
        c_str = c_str.strip('"').strip("'")
        asyncio.run(check_cookie(c_str))
