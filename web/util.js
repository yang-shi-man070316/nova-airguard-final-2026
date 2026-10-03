// 空气质量判定函数
function judgeAirQuality(pm25, co2, temperature, humidity) {
    let level;
    let suggestion;

    if(pm25 <= 35 && co2 <= 1000 && temperature >=20 && temperature <=26 && humidity >=40 && humidity <=60){
        level = "优秀";
        suggestion = "空气质量优秀，适合正常活动";
    }else if(pm25 <=75 && co2 <=1500 && temperature >=18 && temperature <=28 && humidity >=30 && humidity <=70){
        level = "良好";
        suggestion = "空气质量良好，可正常活动";
    }else if(pm25 <=115 || co2 <=2000){
        level = "轻度污染";
        suggestion = "轻度污染，敏感人群减少长时间停留";
    }else{
        level = "污染严重";
        suggestion = "污染严重，建议开窗通风或佩戴防护";
    }

    return {
        level: level,
        suggestion: suggestion
    }
}

// 空气质量状态判定：仅依据 pm25 与 co2（供 web/index.html D1 Web 监测台导入）
export function calcAirStatus(pm25, co2) {
    if (pm25 > 150) {
        return "重度污染";
    }
    if (pm25 > 75) {
        return "轻度污染";
    }
    if (co2 >= 1500) {
        return "通风不足风险";
    }
    return "正常";
}